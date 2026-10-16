# ari-kernel

**Owns:** The in-process TypeScript gateway to the vendored Ari kernel (`packages/arikernel/`): lifecycle, host grants, per-call evaluation, audit-only observation, and the boot-time coverage audit.
**Does not own:** Which tools are allowed (policy rows) → `src/tool-policy/`; the dispatch pipeline that calls it → `src/tool-execution/`; the kernel engine itself → `packages/arikernel/`.
**Entry:** `index.ts` — `ariEvaluate` (the gate), `ariObserve`, `shouldGateInKernel`, `auditKernelCoverage`, `startAriKernel` / `stopAriKernel`, `HOST_CAPABILITY_MANIFEST`.

## Invariants
- `kernelClassForTool` (`tool-class-map.ts`) decides whether a call is checked at all: a gated class (file/http/shell/database/retrieval/secret-vault) goes through `evaluate.ts`; `internal` skips enforcement and is only observed; an unmapped name fails closed (blocked).
- `TOOL_CLASS_MAP` is a projection of `TOOLS` in `src/tool-registry.ts`, itself derived from the policy fragments' `kernel` field — set a tool's class in `src/tool-policy/`, never here.
- `mcp_*` names classify as `http`; third-party plugin tools get their class from `src/plugin-system/tool-metadata.ts`.
- Every gated tool needs a manifest-valid action: its policy row's `ariAction` (required by the row type for every non-`internal` kernel; read by `src/tool-execution/ari-action-map.ts`); `exec` is valid only for shell.
- Boot warns (`coverage.ts`), runtime blocks: a coverage warning in the server log is a real user-facing block.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `HOST_CAPABILITY_MANIFEST` (`manifest.ts`) / `grants.ts` | each policy row's `ariAction` | `src/tool-execution/ari-action-map.test.ts` |
| `tool-class-map.ts` | `src/tool-execution/enforce-policy.ts`, `src/security/layer/layer-core.ts` | `test/ari-kernel-coverage.test.ts` |
| `lifecycle.ts` | `src/server/lifecycle.ts` | `lifecycle-refresh.test.ts` |
| `quarantine.ts` (`TAINT_KEYED_KERNEL_RULES`) | `src/tool-execution/kernel-block.ts` | `src/tool-execution/kernel-quarantine-block.test.ts` |

## Tests
`npx vitest run src/ari-kernel test/ari-kernel-coverage.test.ts` (PowerShell on Windows)
