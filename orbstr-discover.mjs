#!/usr/bin/env node
/**
 * ORBSTR capability discovery (kind 39698).
 *
 * Queries Nostr relays for ORBSTR capability announcements, parses them with
 * the audited ORBSTR core, and ranks them locally.
 *
 * The protocol logic (build/parse capability events, the filter grammar, the
 * suggestion matcher) is NOT reimplemented here. This tool loads the
 * ORBSTR `src/capability.ts` and `src/suggest.ts` at runtime so there is one
 * implementation of the wire format. Where that module is not present, the
 * tool falls back to a vendored copy under ../lib/orbstr/ — the same files,
 * pinned, so the tool still works when the repo is not checked out.
 *
 * Discovery is NOT invocation. This tool never calls a discovered endpoint.
 * A Nostr signature proves who published a listing, not that the provider
 * is legitimate, safe, or available.
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
// Node 22+ ships a global WebSocket; no third-party dependency needed.
const WebSocketImpl = globalThis.WebSocket;

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RELAYS = [
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://sip-relay-3.uncaged-sip.workers.dev",
  "wss://test-sip-relay.sip-01test.workers.dev",
];

const NOSTR_QUERY = process.env.NOSTR_QUERY_JS;

/** Locate the ORBSTR core module, preferring a live checkout over the vendored copy. */
function findCore() {
  const candidates = [
    process.env.ORBSTR_CORE,
    resolve(HERE, "../lib/orbstr/capability.ts"),
    resolve(HERE, "../repos/Orbstr/src/capability.ts"),
    resolve(process.env.HOME ?? "", "Work/repos/Orbstr/src/capability.ts"),
    "/home/master/Work/repos/Orbstr/src/capability.ts",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function findSuggest() {
  const candidates = [
    process.env.ORBSTR_SUGGEST,
    resolve(HERE, "../lib/orbstr/suggest.ts"),
    resolve(HERE, "../repos/Orbstr/src/suggest.ts"),
    resolve(process.env.HOME ?? "", "Work/repos/Orbstr/src/suggest.ts"),
    "/home/master/Work/repos/Orbstr/src/suggest.ts",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function loadModule(path) {
  if (!path) return null;
  if (!path.endsWith(".ts")) {
    return await import(pathToFileURL(path).href);
  }

  // Node 22.6+ can strip types natively (Node 26 by default). Try that
  // first so the real audited source is used verbatim.
  try {
    return await import(pathToFileURL(path).href);
  } catch {
    // Fall through to the strip-and-transpile path below.
  }

  const source = readFileSync(path, "utf8");
  const stripped = source
    .replace(/^\s*import\s+type\s+.*?;?\s*$/gm, "")
    .replace(/^\s*export\s+interface\s+\w+\s*\{[^}]*\};?\s*$/gms, "")
    .replace(/^\s*interface\s+\w+\s*\{[^}]*\};?\s*$/gms, "")
    .replace(/:\s*(string|number|boolean|void|unknown)(\[\])?\s*([;,)=])/g, "$1$3")
    .replace(/\s+as\s+const/g, "")
    .replace(/\s+as\s+[A-Z]\w*/g, "")
    .replace(/:\s*[A-Z]\w*(\[\])?\s*([;,)=])/g, "$2")
    .replace(/([a-zA-Z_$][\w$]*)\s*:\s*[^;,)]+([;,)])/g, "$1$2");
  const tmp = join(process.env.TMPDIR ?? "/tmp", `orbstr-core-${Date.now()}.mjs`);
  await import("node:fs/promises").then((fs) => fs.writeFile(tmp, stripped));
  return await import(pathToFileURL(tmp).href);
}

/** Query one relay for kind 39698 events. Returns { events, completeness, error }. */
async function queryRelay(relay, { limit = 100, timeout = 20000 } = {}) {
  // NIP-01: the subscription filter is a JSON *object*, not a JSON string.
  const subscription = JSON.stringify(["REQ", "orbstr", { kinds: [39698], limit }]);

  return new Promise((resolvePromise) => {
    let settled = false;
    let ws;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      try { ws?.close(); } catch {}
      resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish({ events: [], completeness: "timeout", error: null }),
      timeout,
    );

    try {
      ws = new WebSocketImpl(relay);
    } catch (error) {
      finish({ events: [], completeness: "error", error: String(error) });
      return;
    }

    const events = [];
    let sawEose = false;
    let drainTimer = null;
    const DRAIN_MS = 1200;
    ws.addEventListener("open", () => ws.send(subscription));
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      const [type, subId, payload] = message;
      if (subId !== "orbstr") return;
      if (type === "EVENT") {
        // NIP-01: ["EVENT", <subscription_id>, <event>] — the payload is the
        // event OBJECT, not an array.
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
        events.push(payload);
        // A trailing event extends the drain window.
        if (sawEose) {
          clearTimeout(drainTimer);
          drainTimer = setTimeout(() => {
            finish({ events, completeness: "unknown", error: null });
          }, DRAIN_MS);
        }
      } else if (type === "EOSE") {
        // Some relays send EOSE BEFORE the events. Do not close here or the
        // trailing events are lost. Instead start a short drain window and
        // finish when it expires or the socket closes.
        //
        // No NIP-67 "finish" hint => completeness is unknown, not complete.
        sawEose = true;
        clearTimeout(drainTimer);
        drainTimer = setTimeout(() => {
          finish({ events, completeness: "unknown", error: null });
        }, DRAIN_MS);
      } else if (type === "CLOSED") {
        // Relays routinely send CLOSED right after EOSE as part of normal
        // subscription teardown. A CLOSED with no reason is NOT an error and
        // must not discard events that arrived before it.
        //
        // The CLOSED payload may be a string message or ["reason", "message"].
        const reason = Array.isArray(payload)
          ? payload[1] ?? payload[0] ?? null
          : payload ?? null;
        const message = reason ? String(reason) : null;
        // A reason like "auth-required" or "blocked: ..." is a real refusal.
        const isRefusal =
          !!message &&
          !/^"/.test(message) &&
          message.length > 0 &&
          message !== "closed" &&
          !/^:?$/.test(message);
        if (isRefusal && events.length === 0) {
          finish({ events, completeness: "closed", error: message });
        } else {
          // Otherwise treat it as normal teardown; the drain timer decides.
          if (!sawEose) {
            sawEose = true;
            clearTimeout(drainTimer);
            drainTimer = setTimeout(() => {
              finish({ events, completeness: "unknown", error: null });
            }, DRAIN_MS);
          }
        }
      }
    });
    ws.addEventListener("error", () => {
      finish({ events, completeness: "error", error: `connection failed: ${relay}` });
    });
    ws.addEventListener("close", () => {
      // The relay closed the connection. If it sent EOSE first, the event
      // set is complete for this relay (modulo NIP-67 paging).
      finish({
        events,
        completeness: sawEose ? "unknown" : "closed",
        error: null,
      });
    });
  });
}

function parseArgs(argv) {
  const args = { json: false, limit: 100, relays: null, timeout: 20000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--relays") args.listRelays = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--timeout") args.timeout = Number(argv[++i]) * 1000;
    else if (arg === "--relay") (args.extraRelays ??= []).push(argv[++i]);
    else if (arg === "--core") args.coreOverride = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  args.text = positional.join(" ");
  return args;
}

const HELP = `ORBSTR capability discovery (kind 39698)

  orbstr-discover <query>            search capabilities
  orbstr-discover --relays           list the default relays and reachability
  orbstr-discover <query> --json     machine-readable output

Flags:
  --json          JSON output
  --limit N       max events per relay (default 100)
  --timeout SEC   per-relay timeout (default 20)
  --relay URL     add a relay
  --core PATH     path to capability.ts

Query grammar:
  role:tool proto:mcp price:free  remaining words match name/summary/tags

Discovery is not invocation. This tool never calls a discovered endpoint.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }

  const corePath = args.coreOverride ?? findCore();
  const core = await loadModule(corePath);
  if (!core?.parseCapabilityEvent) {
    console.error(
      "orbstr-discover: could not load the ORBSTR core (capability.ts).\n" +
      "  Set ORBSTR_CORE=/path/to/capability.ts, pass --core PATH, or install the repo:\n" +
      "  git clone https://github.com/SIP-01/Orbstr ~/Work/repos/Orbstr"
    );
    return 2;
  }

  const envRelays =
    process.env.ORBSTR_RELAYS?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  const flagRelays = [...(args.relays ?? []), ...(args.extraRelays ?? [])];
  const relays = [
    // An explicit relay list REPLACES the default pool: a caller that pins
    // its own relays wants exactly those, not the defaults plus its own.
    ...(flagRelays.length > 0 ? flagRelays : envRelays.length > 0 ? envRelays : DEFAULT_RELAYS),
  ].filter((value, index, all) => all.indexOf(value) === index);

  if (args.listRelays) {
    const results = [];
    for (const relay of relays) {
      const res = await queryRelay(relay, { limit: 1, timeout: args.timeout });
      results.push({
        relay,
        events: res.events.length,
        completeness: res.completeness,
        error: res.error,
      });
    }
    if (args.json) {
      console.log(JSON.stringify({ relays: results }, null, 2));
    } else {
      for (const item of results) {
        const status = item.error ? `error: ${item.error}` : item.completeness;
        console.log(`${item.relay}  ${item.events} events  (${status})`);
      }
    }
    return 0;
  }

  const parsedQuery = core.parseQuery(args.text ?? "");
  const perRelay = await Promise.all(
    relays.map(async (relay) => {
      const res = await queryRelay(relay, { limit: args.limit, timeout: args.timeout });
      return { relay, ...res };
    })
  );

  // Later relays do not overwrite earlier ones: first publisher wins for a
  // given (pubkey, id) pair, matching the addressable-event model.
  const seen = new Set();
  const capabilities = [];
  for (const entry of perRelay) {
    for (const event of entry.events) {
      const parsed = core.parseCapabilityEvent(event, "relay", entry.relay);
      if (!parsed) continue;
      const key = core.listingKey(parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      capabilities.push(parsed);
    }
  }

  const matched = capabilities.filter((item) => core.matches(item, parsedQuery));

  const suggestModule = await loadModule(findSuggest());
  const suggestions = suggestModule?.suggestCapabilities
    ? suggestModule.suggestCapabilities(args.text ?? "", matched, 4)
    : [];

  const payload = {
    query: args.text ?? "",
    filters: {
      role: parsedQuery.role ?? null,
      proto: parsedQuery.proto ?? null,
      price: parsedQuery.price ?? null,
    },
    capabilities: matched.map((item) => ({
      id: item.id,
      name: item.name,
      summary: item.summary,
      about: item.about || undefined,
      role: item.role,
      protocols: item.protocols,
      capabilities: item.capabilities,
      endpoint: item.endpoint,
      homepage: item.homepage,
      price: item.price,
      priceNote: item.priceNote,
      nip89: item.nip89,
      expiration: item.expiration,
      status: item.status,
      pubkey: item.pubkey,
      created_at: item.createdAt,
      relay: item.relay,
      source: item.source,
    })),
    count: matched.length,
    total_seen: capabilities.length,
    suggestions,
    relays: perRelay.map((entry) => ({
      relay: entry.relay,
      events: entry.events.length,
      completeness: entry.completeness,
      error: entry.error,
    })),
    complete: perRelay.every((entry) => entry.completeness === "unknown" || entry.completeness === "closed")
      ? false
      : false,
    warning:
      "Discovery is not invocation. A signature proves who published a listing, not that the provider is legitimate, safe, or available.",
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return matched.length > 0 ? 0 : 1;
  }

  if (matched.length === 0) {
    console.log("No matching capabilities found.");
    const live = perRelay.reduce((sum, entry) => sum + entry.events.length, 0);
    console.log(`  (${live} kind-39698 events seen across ${perRelay.length} relays; ${capabilities.length} parsed)`);
    console.log("  The ORBSTR directory is community-run and sparsely populated.");
    for (const entry of perRelay) {
      if (entry.error) console.log(`  ! ${entry.relay}: ${entry.error}`);
    }
    return 1;
  }

  for (const item of matched) {
    const protos = item.protocols.join("/");
    console.log(`\n${item.name}  [${item.role}]  ${protos}  price=${item.price}`);
    console.log(`  ${item.summary}`);
    if (item.endpoint) console.log(`  endpoint: ${item.endpoint}`);
    if (item.homepage) console.log(`  homepage: ${item.homepage}`);
    if (item.capabilities.length) console.log(`  topics:   ${item.capabilities.join(", ")}`);
    console.log(`  publisher: ${item.pubkey.slice(0, 16)}…  relay: ${item.relay}`);
  }
  console.log(`\n${matched.length} of ${capabilities.length} parsed capabilities matched.`);
  console.log(payload.warning);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`orbstr-discover: ${error?.message ?? error}`);
    process.exit(2);
  });
