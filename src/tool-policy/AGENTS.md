# tool-policy

**Owns:** The default-deny per-tool policy table (kernel class, risk tier, allow/deny/confirm rules, rate limit, path args) and the unified pack evaluator that applies it.
**Does not own:** Enforcement at dispatch → `src/tool-execution/`; the kernel → `src/ari-kernel/`; file/shell/network verdicts → `src/security/layer/`.
**Entry:** `index.ts` (`ToolPolicy`, `loadToolPolicy`, `auditPolicyCoverage`); `tool-policies.ts` derivations (`TOOLS`, default rules, rate limits); `evaluator.ts` runs the `packs/` in priority order.

## Invariants
- A new tool gets ONE entry in the matching `tool-policies.<domain>.ts` fragment (`core`, `network`, `memory`, `orchestration`, `apps`, `globs`). `tool-policies.data.ts` is only the merge barrel — never edit it; fragments partition the keyspace, no key in two files.
- Entry fields (`tool-policies.types.ts`): `kernel`, `risk`, `pathArgs`, `offBoxFetch`, `rules`, `rateLimit`. No matching rule means deny-by-default at runtime — there is no risk-tier fallback.
- `offBoxFetch: true` must mirror membership in `EGRESS_TOOLS` (`src/tool-registry.ts`); a path-taking tool without `pathArgs` bypasses file confinement.
- Never add a broad `*` allow. User overrides in the data dir's `tool-policy.json` are merged on top by `merge-defaults.ts`, never replace the defaults.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| a fragment entry | `TOOLS` / `TOOL_PATH_ARGS` in `src/tool-registry.ts`, `TOOL_CLASS_MAP` in `src/ari-kernel/tool-class-map.ts` | `src/tool-policy-default.test.ts`, `src/tools/tool-registration-completeness.test.ts` |
| `offBoxFetch` | `EGRESS_TOOLS` | `src/tool-execution/capability-class-gates.test.ts` |
| `merge-defaults.ts` | the stamped default policy written on first run | `merge-defaults.test.ts` |
| a pack in `packs/` | `src/tool-execution/pre-dispatch.ts` | `packs/spend-cap-pack.test.ts`, `packs/threat-engine-pack.test.ts` |

## Tests
`npx vitest run src/tool-policy src/tool-policy-default.test.ts` (PowerShell on Windows)
