# tool-policy

**Owns:** The default-deny per-tool policy table (kernel class, risk tier, allow/deny/confirm rules, rate limit, path args) and the unified pack evaluator that applies it.
**Does not own:** Enforcement at dispatch → `src/tool-execution/`; the kernel → `src/ari-kernel/`; file/shell/network verdicts → `src/security/layer/`.
**Entry:** `index.ts` (`ToolPolicy`, `loadToolPolicy`, `auditPolicyCoverage`); `tool-policies.ts` derivations (`TOOLS`, default rules, rate limits); `evaluator.ts` runs the `packs/` in priority order.

## Invariants
- A new tool gets ONE entry in the matching `tool-policies.<domain>.ts` fragment (`core`, `network`, `memory`, `orchestration`, `apps`, `globs`). `tool-policies.data.ts` is only the merge barrel — never edit it; fragments partition the keyspace, no key in two files.
- Row fields (`tool-policies.types.ts` `ToolPolicyRow`): `kernel`, `risk`, `capabilities` (required), `pathArgs`, `offBoxFetch`, `shellCommand`, `secretEnv`, `output`, `externalContent`, `destination`, `undo` (required exactly when `risk` is `destructive`), `destructiveActions`, `ariAction` (required exactly when `kernel` is not `internal`), `timeoutMs`, `liveState`, `deniedIn`, `wholeToolGrant`, `readOnlyUnless`, `rules`, `rateLimit`. No matching rule means deny-by-default at runtime — there is no risk-tier fallback. Glob entries (`GlobPolicyEntry`) carry only `rules`/`rateLimit`.
- A row is the one place a tool's facts live: the capability classes are read off it (`src/tool-registry.ts` `hasCapability`) — `egress` / `sensitive-read` / `shell` from `capabilities`, `workspace-write` from the `pathArgs` that write, edit or delete — so no gate keeps a list of tool names. `offBoxFetch: true` requires `egress`; a path-taking tool without `pathArgs` bypasses file confinement.
- What a call runs and returns is on the row too, read through one accessor each in `src/tool-registry.ts`: `shellCommand` names the arg holding a model-authored shell command (`shellCommandOf`; `waitsForExit` when the result arrives after it exits) — the destructive floor, the publish gate, the delete card, grant scopes and `allowedCommands` all read it; `output` says what a result carries (`command`, `http-body`, `file-content`, `mailbox`) for masking and taint (`outputOf`); `externalContent: true` marks a result as off-box content for the memory-promotion axis (`src/data-lineage/external.ts`); `destination` says where a send delivers (`DestinationSpec`, read through `destinationSpecsOf`), which names it on the private-content card, keys an "always allow", picks the outbound scan's allowlist and marks a message to a person.
- Never add a broad `*` allow. User overrides in the data dir's `tool-policy.json` are merged on top by `merge-defaults.ts`, never replace the defaults.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| a fragment entry | `TOOLS` / `TOOL_PATH_ARGS` in `src/tool-registry.ts`, `TOOL_CLASS_MAP` in `src/ari-kernel/tool-class-map.ts` | `src/tool-policy-default.test.ts`, `src/tools/tool-registration-completeness.test.ts` |
| `capabilities` / `offBoxFetch` / a write `pathArgs` spec | every gate keyed on a capability class (`hasCapability`) | `src/tool-execution/capability-class-gates.test.ts` |
| `risk`, `pathArgs`, `ariAction`, `destination`, `readOnlyUnless` (what plan mode permits: `isReadOnlyCall` in `src/tool-registry.ts`), `deniedIn` (`CONTEXT_RESTRICTED_TOOLS`), `wholeToolGrant` (`WHOLE_TOOL_GRANTS`), a `write` path spec (`CREATE_CLASS`) | plan mode, the security layer's context rule, the approval cache, the task-artifact pre-stat | `src/tools/plan-mode-read-only.test.ts` |
| `undo` / `destructiveActions` | the undo pairing a tool set keeps (`src/tools/undo-pairs.ts`), the irreversible floor's card (`src/irreversible-tools.ts`), `destructiveOperationReason` | `src/tools/undo-pairs.test.ts`, `src/irreversible-tool-floor.test.ts` |
| `shellCommand` / `output` / `externalContent` | the shell-command gates, result masking, the external-content axis | `src/tool-execution/command-output-facts.test.ts` |
| `secretEnv` | `SECRET_ENV_TOOLS` (`src/tools/shell-secret-env.ts`): the `use_secret` card and the outbound-secret recovery; the tool's schema must take `secret_env` | `src/tools/tool-registration-completeness.test.ts` |
| `kernel`, `risk`, a `shell` capability, `destination` (what strict local-only mode blocks: `localOnlyToolDecision` in `src/local-only-policy.ts`; a `site` or `browser-page` destination is judged by the call's URL) | the two maps there for reach no row names (`INDIRECT_NETWORK`, `LOCAL_DEVICE`) | `src/local-only-policy.test.ts` |
| an `edit` path spec, a family's `edit` action, a `searchRoot`, `shellCommand` (`EDIT_CAPABLE_TOOLS` in `src/agents/spawn-guard.ts`) | which roles a task that edits an existing artifact may be delegated to | `src/agents/spawn-guard.test.ts` |
| `knowsContent` on a path spec (read by the stale-read guard in `src/tool-execution/run-sandboxed.ts`) | an `edit` spec is refused against a file the session has not seen current; a `write` spec is refused the same way when the file already exists (a whole-file write replaces it); a `read` spec only records the sight | `src/tool-execution/run-sandboxed.test.ts` |
| `pathArgs` (also read by the Artifacts tab, `src/routes/artifacts.ts`) | every declared path a session touched is surfaced there | `src/routes/artifacts.test.ts` |
| `merge-defaults.ts` | the stamped default policy written on first run | `merge-defaults.test.ts` |
| a pack in `packs/` | `src/tool-execution/pre-dispatch.ts` | `packs/spend-cap-pack.test.ts`, `packs/threat-engine-pack.test.ts` |

## Tests
`npx vitest run src/tool-policy src/tool-policy-default.test.ts` (PowerShell on Windows)
