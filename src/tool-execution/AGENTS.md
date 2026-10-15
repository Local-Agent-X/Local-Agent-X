# tool-execution

**Owns:** The dispatch pipeline every model-issued tool call passes through — resolve → policy (Ari + rule packs) → approval → sandbox → audit.
**Does not own:** Tool definitions and the registry → `src/tools/`; policy rows → `src/tool-policy/`; the kernel itself → `src/ari-kernel/`.
**Entry:** `index.ts` — `executeToolCalls` / `dispatchSingleToolCall` for model calls; `executeHarnessCommand` (`harness-exec.ts`) for harness-initiated shell (build-verify, spec-probes): kill switch + audit only, no policy/approval/RBAC.

## Invariants
- Never call a tool's `execute` from outside this module: the gates in `pre-dispatch.ts` and `enforce-policy.ts` are what make policy, Ari, approval and RBAC apply.
- Gate order in `enforce-policy.ts` (`securityAndValidationGates`) is load-bearing: name resolution runs before the kernel, so an unknown name reads as "not a tool", not as a kernel fault.
- A kernel-gated tool with no `ARI_ACTION_MAP` row falls through to action `exec`, which the kernel schema rejects — a hard block under `ariRequired`.
- Model-supplied `_`-prefixed args are dropped (`internal-args.ts`); only `SESSION_SCOPED_TOOLS` get the trusted `_sessionId`, only `OPERATION_SCOPED_TOOLS` get `_operationId`.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `ARI_ACTION_MAP` (`ari-action-map.ts`) | `HOST_CAPABILITY_MANIFEST` in `src/ari-kernel/manifest.ts` | `ari-action-map.test.ts` |
| `SESSION_SCOPED_TOOLS` (`resolve-tool.ts`) | every tool body reading `_sessionId` | `session-scoped-tools.test.ts` |
| `OPERATION_SCOPED_TOOLS` (`resolve-tool.ts`) | every tool body reading `_operationId` | none |
| `DEFAULT_TIMEOUTS` (`tool-timeout.ts`) | tools not listed get `DEFAULT_FALLBACK` | `tool-timeout.test.ts` |
| kill-switch table (`kill-switch-gates.ts`) | `FLIPPABLE_SETTINGS` in `src/settings-schema.ts` | `kill-switch-gates.test.ts` |
| `LOCAL_CONTROL_ARGS` (`egress-payload.ts`) | every outbound scan skips those args; the taint floor and `taint-scope.ts` read "nothing to carry" from them | `egress-payload.test.ts` |
| gate order (`pre-dispatch.ts`, `enforce-policy.ts`) | both dispatch callers (chat path, arikernel executors) | `gate-order.test.ts`, `pre-dispatch-matrix.test.ts` |

## Tests
`npx vitest run src/tool-execution` (PowerShell on Windows)
