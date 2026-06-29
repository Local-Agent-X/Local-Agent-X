# eval/dedup-live

Live regression battery for the 8 de-duplication chunks (the forked-rule
unification run). Run it with:

```
npm run eval:dedup
```

## Why this exists

Unit tests prove each helper in isolation; chat prompts are unreliable for
security behavior because the model (and the file-access mode, and the shell
policy) refuse *before* the code under test ever runs — a refusal tells you
nothing about whether the gate fired. This battery calls the **real enforcement
code** directly — the file-access gate, the egress guard, `killProcessGroup`,
the roster seeder, the context-window coverage script — plus real OS/filesystem
side effects, with **no LLM and no HTTP server**. Every check is deterministic
and goes RED on a real regression. Exit 0 = all passed, exit 1 = something
regressed.

Run it before starting new work to confirm the dedup invariants still hold.

## What each chunk's checks actually exercise

| Chunk | Real code path exercised |
|-------|--------------------------|
| 1 credential gate | `evaluateFileAccess(..., "unrestricted", "read", credPath)` is denied (mode allows everything, so only the catalog can block) + `isSensitivePath` agrees (gate ⊇ taint) |
| 2 outbound-payload | `outboundPayloadParts` includes/omits the URL per flag; `checkOutboundRequest` blocks a real secret in the body to an untrusted host |
| 3 background model | `dispatchBackgroundModel(p) === backgroundModelFor(p, "")` for each provider |
| 4 context windows | runs the real `scripts/check-pricing-coverage.mjs`; asserts coverage is N/N and exit 0 |
| 5 killProcessGroup | spawns a real detached child + grandchild, kills the group, asserts **both** die (a `kill(pid)` regression would orphan the grandchild) |
| 6 mcpBridgeBasePath | absolute + extensionless, and the resolved `.ts`/`.js` bridge file exists on disk |
| 7 seedProjectRosters | seeds a CEO-led roster, asserts the persisted `reportsTo` wiring |
| 8 dead headless.ts | the file is gone and nothing references `HeadlessAgent` |

POSIX-only checks (chunk 5's process-group kill) are skipped on Windows and
reported as `SKIP`.
