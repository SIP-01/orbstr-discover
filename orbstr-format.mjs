#!/usr/bin/env node
/**
 * Renders ORBSTR discovery JSON for the terminal.
 *
 *   orbstr-format list  <<< "$RESULTS"
 *   orbstr-format show 2 <<< "$RESULTS"
 *   orbstr-format homepage 2 <<< "$RESULTS"
 *
 * Kept out of the bash wrapper on purpose: embedding this much JSON
 * handling in shell quoting is where the bugs live.
 */

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    console.error("orbstr-format: input is not valid JSON");
    process.exit(2);
  }

  const command = process.argv[2] || "list";
  const index = Number(process.argv[3] || 1) - 1;
  const capabilities = data.capabilities || [];

  if (command === "list") {
    if (!capabilities.length) {
      const live = (data.relays || []).reduce((n, r) => n + (r.events || 0), 0);
      console.log("No matching capabilities.");
      console.log(`  (${live} kind-39698 events seen; ${data.total_seen ?? 0} parsed)`);
      console.log("  The ORBSTR directory is community-run and sparsely populated.");
      for (const relay of data.relays || []) {
        if (relay.error) console.log(`  ! ${relay.relay}: ${relay.error}`);
      }
      process.exit(1);
    }
    capabilities.forEach((capability, i) => {
      console.log(`${i + 1}. ${capability.name}  [${capability.role}]  ${capability.protocols.join("/")}  ${capability.price}`);
      console.log(`   ${capability.summary}`);
    });
    process.exit(0);
  }

  const capability = capabilities[index];
  if (!capability) {
    console.error(`orbstr-format: no capability at index ${index + 1}`);
    process.exit(1);
  }

  if (command === "show") {
    console.log("");
    console.log(`${capability.name}  [${capability.role}]  ${capability.protocols.join("/")}  price=${capability.price}`);
    console.log(`  ${capability.summary}`);
    if (capability.about) console.log(`  ${capability.about}`);
    if (capability.endpoint) console.log(`  endpoint: ${capability.endpoint}`);
    if (capability.homepage) console.log(`  homepage: ${capability.homepage}`);
    if (capability.capabilities?.length) console.log(`  topics:   ${capability.capabilities.join(", ")}`);
    console.log(`  publisher: ${capability.pubkey}`);
    console.log(`  seen on:   ${capability.relay}`);
    console.log("");
    console.log("Discovery is not invocation. Calling this endpoint needs a trusted");
    console.log("SSRF-safe egress gateway and your explicit approval.");
    process.exit(0);
  }

  if (command === "homepage") {
    console.log(capability.homepage || "");
    process.exit(0);
  }

  console.error(`orbstr-format: unknown command ${command}`);
  process.exit(2);
});
