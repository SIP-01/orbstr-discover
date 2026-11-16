# Vendored ORBSTR core

These two files are copied verbatim from the ORBSTR repository so the
tool works on a machine that does not have that repository checked out,
and so the test suite runs anywhere.

| File | Source | Licence |
|---|---|---|
| `capability.ts` | [SIP-01/Orbstr](https://github.com/SIP-01/Orbstr) `src/capability.ts` | MIT |
| `suggest.ts` | [SIP-01/Orbstr](https://github.com/SIP-01/Orbstr) `src/suggest.ts` | MIT |

They are the single audited implementation of the ORBSTR capability
format. The tool loads them at runtime rather than reimplementing the
parser, and prefers a live checkout when one exists — set `ORBSTR_CORE`
and `ORBSTR_SUGGEST` to point at your own copies.

To refresh them from a checkout:

```sh
cp ~/Work/repos/Orbstr/src/capability.ts lib/orbstr/capability.ts
cp ~/Work/repos/Orbstr/src/suggest.ts     lib/orbstr/suggest.ts
```
