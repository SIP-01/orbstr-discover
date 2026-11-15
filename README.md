# orbstr-discover

Discover ORBSTR capability announcements from the terminal.

[ORBSTR](https://github.com/SIP-01/Orbstr) defines kind 39698 — a SIP-01
companion profile where publishers announce tools, models, APIs, datasets and
agents. This tool queries the Nostr relays for those announcements, parses
them with the audited ORBSTR core, and ranks them locally.

```
$ orbstr-discover "role:tool proto:mcp"

ORBSTR verification test  [tool]  mcp  price=free
  Throwaway test listing written during deploy verification. Safe to ignore.
  topics:   verify, test
  publisher: 53d14ff162590d53…  relay: wss://relay.ditto.pub

1 of 1 parsed capabilities matched.
```

## Discovery is not invocation

**This tool never calls a discovered endpoint.** An ORBSTR listing is an
untrusted claim by its publisher: a Nostr signature proves *who* published it,
not that the provider is legitimate, safe, available or good.

Calling one requires a trusted egress gateway that resolves and validates
every A/AAAA record, rejects private and reserved ranges, pins the connected
peer, revalidates redirects, enforces size and time limits, and strips
ambient credentials — plus explicit approval for the exact call.

The ORBSTR skill's `endpointAllowed` helper is a *syntactic* listing filter.
It rejects unsafe URL forms; it is not an SSRF authorization control.

## Install

Requires Node 22.6+ (for native TypeScript type-stripping) and the ORBSTR
core.

```bash
git clone https://github.com/SIP-01/orbstr-discover
cd orbstr-discover
npm install          # dev-only: the test suite's relay stub
install -Dm755 orbstr-discover.mjs ~/.local/bin/orbstr-discover
install -Dm755 orbstr-format.mjs ~/.local/lib/orbstr-discover/orbstr-format.mjs
```

The tool loads the ORBSTR core at runtime so there is one implementation of
the capability event format. It looks for `src/capability.ts` in this order:

1. `$ORBSTR_CORE`
2. `../lib/orbstr/capability.ts` next to the tool
3. `~/Work/repos/Orbstr/src/capability.ts`
4. `/home/master/Work/repos/Orbstr/src/capability.ts`

```bash
git clone https://github.com/SIP-01/Orbstr ~/Work/repos/Orbstr
```

## Usage

```
orbstr-discover <query>             search capabilities
orbstr-discover --relays            relay reachability and event counts
orbstr-discover <query> --json      machine-readable output
```

| Flag | Effect |
| --- | --- |
| `--json` | JSON output |
| `--relay URL` | Query this relay (replaces the default pool) |
| `--limit N` | Max events per relay (default 100) |
| `--timeout SEC` | Per-relay timeout (default 20) |
| `--core PATH` | Path to `capability.ts` |

`ORBSTR_RELAYS` sets the relay pool (comma separated). Like `--relay`, it
**replaces** the default pool rather than adding to it.

Exit codes: `0` matches found, `1` no matches, `2` usage or tool error.

## Query grammar

```
role:tool proto:mcp price:free weather radar
```

- `role:` — `agent`, `tool`, `model`, `api`, `compute`, `dataset`, `gateway`
- `proto:` — `mcp`, `http`, `contextvm`, `nostr`, `a2a`
- `price:` — `free`, `freemium`, `metered`, `subscription`, `prepaid`, `private`

Remaining words match the listing name, summary and topic tags.

## For agents

`--json` returns a stable shape:

```json
{
  "query": "role:tool",
  "filters": { "role": "tool", "proto": null, "price": null },
  "capabilities": [
    {
      "id": "orbstr-verify-test",
      "name": "ORBSTR verification test",
      "summary": "…",
      "role": "tool",
      "protocols": ["mcp"],
      "capabilities": ["verify", "test"],
      "endpoint": "https://…",
      "homepage": "https://…",
      "price": "free",
      "status": "active",
      "pubkey": "…",
      "created_at": 1794180509,
      "relay": "wss://relay.ditto.pub",
      "source": "relay"
    }
  ],
  "count": 1,
  "total_seen": 1,
  "suggestions": [],
  "relays": [
    { "relay": "wss://…", "events": 1, "completeness": "unknown", "error": null }
  ],
  "warning": "Discovery is not invocation…"
}
```

`completeness` is `unknown` unless a relay sent a NIP-67 `finish` hint.
`error` carries the relay's refusal reason when it rejected the subscription.

## Omarchy

`orbstr-discover-tui` is a keyboard-first wrapper: it prompts with `gum`,
lists the capabilities, and shows the details of the one you pick. It offers
to open the publisher's *homepage* — never the capability endpoint.

```bash
install -Dm755 orbstr-discover-tui ~/.local/bin/orbstr-discover-tui
```

To put it in the Omarchy menu, add a row to
`~/.config/omarchy/extensions/omarchy-menu.jsonc`:

```jsonc
"orbstr": {"icon": "<glyph>", "label": "ORBSTR"},
"orbstr.discover": {
  "icon": "<glyph>",
  "label": "Discover capabilities",
  "description": "ORBSTR kind 39698 — announced tools and agents",
  "action": "omarchy-launch-floating-terminal-with-presentation orbstr-discover-tui"
}
```

The menu watches that file and hot-reloads.

## Current state

The directory is **sparsely populated**. As of 2026-11-15, live queries
across six relays return one self-published verification listing. The tool
reports that honestly rather than dressing up an empty result.

## Tests

```bash
npm test
```

16 offline tests. A local relay stub speaks the NIP-01 subset the tool uses,
so the suite touches no network. Two of the tests pin NIP-01 frame details
that are easy to get wrong — the subscription filter is a JSON *object*, and
the `EVENT` payload is the event *object*, not an array.

## License

MIT
