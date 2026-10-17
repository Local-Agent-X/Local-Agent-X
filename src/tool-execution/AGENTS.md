# tool-execution

**Owns:** The dispatch pipeline every model-issued tool call passes through — resolve → policy (Ari + rule packs) → approval → sandbox → audit.
**Does not own:** Tool definitions and the registry → `src/tools/`; policy rows → `src/tool-policy/`; the kernel itself → `src/ari-kernel/`.
**Entry:** `index.ts` — `executeToolCalls` / `dispatchSingleToolCall` for model calls; `executeHarnessCommand` (`harness-exec.ts`) for harness-initiated shell (build-verify, spec-probes): kill switch + audit only, no policy/approval/RBAC; `dispatchApprovedCall` (`approved-call.ts`) to run a call the user approved from the inbox, through `executeToolCalls`.

## Invariants
- Never call a tool's `execute` from outside this module: the gates in `pre-dispatch.ts` and `enforce-policy.ts` are what make policy, Ari, approval and RBAC apply.
- Gate order in `enforce-policy.ts` (`securityAndValidationGates`) is load-bearing: name resolution runs before the kernel, so an unknown name reads as "not a tool", not as a kernel fault.
- A kernel-gated tool's kernel action is its row's `ariAction`, which the row type requires: one that fell through to `exec` was rejected by the kernel schema — a hard block under `ariRequired`.
- Model-supplied `_`-prefixed args are dropped (`internal-args.ts`); only `SESSION_SCOPED_TOOLS` get the trusted `_sessionId` (every tool with policy `pathArgs` is in it automatically), only `OPERATION_SCOPED_TOOLS` get `_operationId`; every call gets `_onEvent` and `_toolCallId`. A tool reads a stamp only through its accessor in `internal-args.ts` (`sessionIdOf`, `onEventOf`, `cwdOf`, …), never `args._x`, and only the dispatch pipeline writes one (`internal-args.test.ts` scans both). The stamps are never part of a call's identity: the side-effect journal fingerprints, the kernel bridge forwards and the approval card shows `withoutInternalArgs(args)`.
- A tool path argument is resolved with the call's session everywhere it is resolved: the file-access gate (`ctx.sessionId`), the tool (`sessionIdOf(args)`), and every check here about the same file (freshness, read-dedup, task-artifact pre-stat, the delete gates). Otherwise a work-rooted session gates `<workRoot>/x` and opens `<workspace>/x`. Guards: `agent-path-session.test.ts` (source scan), `test/work-root-gate-sink-parity.test.ts`.
- Every tool result the model reads is screened once, in the audit phase (`injection-exposure.ts`), never in a tool or a provider: the content is never edited, a note leads the rendered text, and harness text (the wrapper's frame, `read`'s warning) is never scanned.
- A tool message is built by `toolMessage()` (`tool-message-carry.ts`) and nothing else: the model reads its text, the harness reads its carry (`_status`, `_block`, `_media`) through `toolMessageStatus` / `toolMessageBlock` / `toolMessageMedia`. Nothing new parses the `[status, k=v]` header back out of the text; `parseStatusHeader` / `parseResultHeader` serve rows persisted before the carry existed (2026-10-17) and nothing else. A refusal's `metadata.layer` is a `BlockLayer` (`src/types/tool-block.ts` `BLOCK_LAYERS`), which the type requires beside `recovery`.
- An unattended run never pauses for a person. A gate that would need one parks the call in the user's inbox (`deferred-call.ts` `parkOrRefuse`) and the run goes on: the result stays status `blocked`, `metadata.layer` `"approval"`, marked by `metadata.deferredTo` (the item id, carried on the block record), with the gate's own reason. Never a new status, and never a loop guard reading the wording.
- The user's Approve is a one-shot grant on the ApprovalManager for that exact call in its session (`src/approval-call-grants.ts`), never a flag that skips gates. Each gate that would park, refuse or prompt for want of a person calls `takeUserGrant` first (the approval phase, the `secret_env` card, the unattended shell gate; `requestApprovalDetailed` takes it too); it sets `ctx.approvedByUser`. Every other gate re-runs. `dispatchApprovedCall` revokes the grant when the dispatch returns.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| a row's `ariAction` (read by `ari-action-map.ts`) | `HOST_CAPABILITY_MANIFEST` in `src/ari-kernel/manifest.ts` | `ari-action-map.test.ts` |
| `SESSION_SCOPED_TOOLS` (`resolve-tool.ts`) | every tool body calling `sessionIdOf(args)`; `TOOL_PATH_ARGS` | `session-scoped-tools.test.ts` |
| a stamp's name or shape (`internal-args.ts` accessors) | the stamping sites named in `internal-args.test.ts` WRITERS (`resolve-tool.ts`, `tool-runner.ts`, `enforce-policy.ts`, `plugins.ts`, `browser-tools/gates.ts`) | `internal-args.test.ts` |
| `OPERATION_SCOPED_TOOLS` (`resolve-tool.ts`) | every tool body reading `_operationId` | none |
| a row's `timeoutMs` (read by `tool-timeout.ts`) | a row without one gets `DEFAULT_FALLBACK` | `tool-timeout.test.ts` |
| a row's `liveState` (read by `stateful-tools.ts`) | the session repeat skip, the 60 s dedup cache, the threat engine's loop arms (`poll` only) | `stateful-tools.test.ts` |
| kill-switch table (`kill-switch-gates.ts`) | `FLIPPABLE_SETTINGS` in `src/settings-schema.ts` | `kill-switch-gates.test.ts` |
| a row's `destination`, or how `send-destinations.ts` resolves one | the private-content gate's destinations, the "always allow" scope of every send (`src/approval-decision.ts`), the outbound secret scan's allowlist (`egress-gates.ts`, `isTrustedSend`), site provenance, the refutation pack's message-to-a-person test | `private-content-destinations.test.ts`, `src/approval-grant-scope.test.ts`, `src/threat/send-clearance.test.ts`, `src/browser/site-provenance.test.ts` |
| `LOCAL_CONTROL_ARGS` (`egress-payload.ts`) | every outbound scan skips those args; the taint floor and `taint-scope.ts` read "nothing to carry" from them | `egress-payload.test.ts` |
| a row's `secretEnv` (`SECRET_ENV_TOOLS` in `src/tools/shell-secret-env.ts` is derived from it) | the `use_secret` card (`secret-env-approval.ts`) and the outbound-secret recovery (`stored-secret-route.ts`) cover exactly those tools | `src/tools/tool-registration-completeness.test.ts`, `secret-env-approval.test.ts` |
| `askAfterInjectionExposure` on each profile (`src/autonomy/profiles.ts`) | the exposure gate (`injection-exposure.ts`) asks only for risks a profile lists and would otherwise run; an empty list is "note only" | `injection-exposure.test.ts`, `src/autonomy/profiles.test.ts` |
| `metadata.injection` a tool reports (`read`, `read-imports.ts`) | the result screen trusts it instead of re-scanning text that carries the tool's own warning | `injection-exposure.test.ts` |
| gate order (`pre-dispatch.ts`, `enforce-policy.ts`) | both dispatch callers (chat path, arikernel executors) | `gate-order.test.ts`, `pre-dispatch-matrix.test.ts` |
| a gate that refuses an unattended call for want of a person | it must park through `parkOrRefuse` and take the one-shot grant (`takeUserGrant`) before parking, refusing or prompting, or an approved call is parked again | `deferred-call.test.ts`, `approved-call.test.ts` |
| the one-shot grant key (`src/approval-call-grants.ts`, `exactKey`) | the args the parked record keeps (`deferred-call.ts`, minus `_` keys) must key the same as the re-dispatched call's | `src/approval-call-grants.test.ts`, `approved-call.test.ts` |
| the parked result's shape (`metadata.deferredTo`, `tool-message-carry.ts`) | `src/canonical-loop/middlewares/repeat-failure.ts` groups parked shell calls off `block.deferredTo` | `src/canonical-loop/middlewares/repeat-failure.test.ts` |
| the carry (`tool-message-carry.ts`) or `BLOCK_LAYERS` | `src/canonical-loop/chat-tool-dispatcher.ts` lifts status/block/media off it; `message-convert.ts` writes it back onto session rows; `public/js/chat-declassify-action.js` keys the notice on layer names | `tool-message-carry.test.ts`, `test/kernel-block-notice.test.ts` |

## Tests
`npx vitest run src/tool-execution` (PowerShell on Windows)
