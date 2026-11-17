#!/usr/bin/env node
/**
 * Offline test suite for orbstr-discover.
 *
 * The relay is stubbed: a local WebSocket server speaks the NIP-01 subset
 * the tool uses, so the suite touches no network.
 *
 *   node --test test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "../orbstr-discover.mjs");

/** A NIP-01 event for a capability announcement. */
function capabilityEvent({
  id = "test-capability",
  pubkey = "53d14ff162590d53e262eb811c5c44a972bf82c11cc054359763b5b6e028e0f5",
  name = "Test Capability",
  summary = "A test capability listing.",
  role = "tool",
  protocols = ["mcp"],
  price = "free",
  topics = ["testing"],
  endpoint,
  created_at = 1794180509,
} = {}) {
  return {
    id: "34c2db94fddaa5120d47cfae6946935b26c5f6d920ce300a04f74108fe02cdbc",
    pubkey,
    created_at,
    kind: 39698,
    content: JSON.stringify({ name, summary }),
    tags: [
      ["d", id],
      ["v", "1"],
      ["role", role],
      ...protocols.map((proto) => ["proto", proto]),
      ["price", price],
      ...topics.map((topic) => ["t", topic]),
      ...(endpoint ? [["endpoint", endpoint]] : []),
    ],
  };
}

/**
 * A stub relay. `script` decides what to send for each incoming REQ.
 */
async function startRelay(script) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const { port } = wss.address();

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message[0] !== "REQ") return;
      const [, subId, filter] = message;
      const events = script(filter) ?? [];
      for (const event of events) {
        socket.send(JSON.stringify(["EVENT", subId, event]));
      }
      socket.send(JSON.stringify(["EOSE", subId]));
    });
  });

  return {
    // The stub speaks plaintext, so the URL must be ws:// not wss://.
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise((done) => wss.close(done)),
  };
}

/** Run the tool and capture stdout. */
function run(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TOOL, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- protocol

test("NIP-01: the EVENT payload is an object, not an array", async () => {
  // This exact shape broke the tool once: a guard of Array.isArray(payload)
  // silently dropped every event. Pin the frame format.
  const relay = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json", "--relay", relay.url], {
      ORBSTR_RELAYS: relay.url,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_seen, 1, "one capability should be parsed");
    assert.equal(payload.capabilities[0].id, "test-capability");
  } finally {
    await relay.close();
  }
});

test("NIP-01: the subscription filter is an object, not a JSON string", async () => {
  let seenFilter = null;
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const { port } = wss.address();
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      seenFilter = message[2];
      socket.send(JSON.stringify(["EOSE", message[1]]));
    });
  });
  try {
    await run(["--json"], { ORBSTR_RELAYS: `ws://127.0.0.1:${port}` });
    assert.equal(typeof seenFilter, "object");
    assert.notEqual(typeof seenFilter, "string");
    assert.deepEqual(seenFilter.kinds, [39698]);
  } finally {
    await new Promise((done) => wss.close(done));
  }
});

// ---------------------------------------------------------------- parsing

test("parses a capability announcement into the ORBSTR shape", async () => {
  const relay = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    const cap = payload.capabilities[0];
    assert.equal(cap.name, "Test Capability");
    assert.equal(cap.role, "tool");
    assert.deepEqual(cap.protocols, ["mcp"]);
    assert.equal(cap.price, "free");
    assert.deepEqual(cap.capabilities, ["testing"]);
    assert.equal(cap.status, "active");
  } finally {
    await relay.close();
  }
});

test("rejects a capability event with the wrong schema version", async () => {
  const event = capabilityEvent();
  event.tags = event.tags.map((tag) => (tag[0] === "v" ? ["v", "99"] : tag));
  const relay = await startRelay(() => [event]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_seen, 0, "v=99 must not parse");
  } finally {
    await relay.close();
  }
});

test("rejects a capability event with a missing d tag", async () => {
  const event = capabilityEvent();
  event.tags = event.tags.filter((tag) => tag[0] !== "d");
  const relay = await startRelay(() => [event]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    assert.equal(JSON.parse(result.stdout).total_seen, 0);
  } finally {
    await relay.close();
  }
});

test("marks a withdrawn capability as withdrawn", async () => {
  const event = capabilityEvent();
  event.tags.push(["status", "withdrawn"]);
  const relay = await startRelay(() => [event]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    // Withdrawn listings are parsed but never match a query.
    assert.equal(payload.total_seen, 1);
    assert.equal(payload.count, 0);
  } finally {
    await relay.close();
  }
});

test("dedupes the same (pubkey, d) seen on two relays", async () => {
  const relayA = await startRelay(() => [capabilityEvent()]);
  const relayB = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json"], {
      ORBSTR_RELAYS: `${relayA.url},${relayB.url}`,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_seen, 1, "one listing, two relays");
    assert.equal(payload.count, 1);
  } finally {
    await relayA.close();
    await relayB.close();
  }
});

// ---------------------------------------------------------------- filtering

test("role: filter matches only that role", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a-tool", role: "tool" }),
    capabilityEvent({ id: "b-agent", role: "agent" }),
  ]);
  try {
    const result = await run(["--json", "role:tool"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.capabilities[0].id, "a-tool");
  } finally {
    await relay.close();
  }
});

test("proto: filter matches only that protocol", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a-mcp", protocols: ["mcp"] }),
    capabilityEvent({ id: "b-a2a", protocols: ["a2a"] }),
  ]);
  try {
    const result = await run(["--json", "proto:mcp"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.capabilities[0].id, "a-mcp");
  } finally {
    await relay.close();
  }
});

test("cap: filters require every requested capability tag", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a-search-research", topics: ["search", "research"] }),
    capabilityEvent({ id: "b-search-only", topics: ["search"] }),
    capabilityEvent({ id: "c-research-only", topics: ["research"] }),
  ]);
  try {
    const result = await run(["--json", "role:tool", "cap:search", "cap:research"], {
      ORBSTR_RELAYS: relay.url,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.capabilities[0].id, "a-search-research");
    assert.deepEqual(payload.filters.capabilities, ["search", "research"]);
  } finally {
    await relay.close();
  }
});

test("capability: is an alias and capability filters are case-insensitive", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a", topics: ["code-review"] }),
    capabilityEvent({ id: "b", topics: ["research"] }),
  ]);
  try {
    const result = await run(["--json", "capability:CODE-REVIEW"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.capabilities[0].id, "a");
    assert.deepEqual(payload.filters.capabilities, ["code-review"]);
  } finally {
    await relay.close();
  }
});

test("price: filter matches only that price", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a-free", price: "free" }),
    capabilityEvent({ id: "b-metered", price: "metered" }),
  ]);
  try {
    const result = await run(["--json", "price:free"], { ORBSTR_RELAYS: relay.url });
    assert.equal(JSON.parse(result.stdout).count, 1);
  } finally {
    await relay.close();
  }
});

test("free text matches name, summary and topic tags", async () => {
  const relay = await startRelay(() => [
    capabilityEvent({ id: "a", name: "Weather Radar", summary: "Forecast data." }),
    capabilityEvent({ id: "b", name: "Unrelated", summary: "Nothing here." }),
  ]);
  try {
    const result = await run(["--json", "weather"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.capabilities[0].id, "a");
  } finally {
    await relay.close();
  }
});

test("a query that matches nothing returns zero results", async () => {
  const relay = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json", "zzzznotpresent"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 0);
    assert.equal(result.code, 1, "exit code 1 means no results");
  } finally {
    await relay.close();
  }
});

// ---------------------------------------------------------------- safety

test("never calls a discovered endpoint", async () => {
  // The listing points at a host nothing is listening on. If the tool tried
  // to invoke it, this would produce a connection error in the output.
  const relay = await startRelay(() => [
    capabilityEvent({
      endpoint: "https://127.0.0.1:9/should-never-be-called",
    }),
  ]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    assert.ok(!result.stderr.includes("ECONNREFUSED"), "no endpoint call attempted");
    assert.ok(!result.stderr.includes("should-never-be-called"), "endpoint not fetched");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.capabilities[0].endpoint, "https://127.0.0.1:9/should-never-be-called");
  } finally {
    await relay.close();
  }
});

test("rejects a non-https endpoint in a listing", async () => {
  const relay = await startRelay(() => [capabilityEvent({ endpoint: "http://evil.example" })]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    assert.equal(JSON.parse(result.stdout).total_seen, 0);
  } finally {
    await relay.close();
  }
});

test("the output carries the discovery-is-not-invocation warning", async () => {
  const relay = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json"], { ORBSTR_RELAYS: relay.url });
    const payload = JSON.parse(result.stdout);
    assert.match(payload.warning, /not invocation/i);
  } finally {
    await relay.close();
  }
});

test("reports an unreachable relay without failing the run", async () => {
  const relay = await startRelay(() => [capabilityEvent()]);
  try {
    const result = await run(["--json"], {
      ORBSTR_RELAYS: `${relay.url},ws://127.0.0.1:9`,
    });
    const payload = JSON.parse(result.stdout);
    const dead = payload.relays.find((r) => r.relay.includes(":9"));
    assert.ok(dead, "the dead relay is reported");
    assert.ok(dead.error, "with an error");
    assert.equal(payload.count, 1, "the live relay still produced results");
  } finally {
    await relay.close();
  }
});
