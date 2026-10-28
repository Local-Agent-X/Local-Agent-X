# security

**Owns:** The SecurityLayer decision core — file-access confinement, shell-command policy, network/egress policy (`layer/`) — and secret/credential detection and redaction (`secrets/`).
**Does not own:** The Ari kernel → `src/ari-kernel/`; the threat engine, audit trail and canaries → `src/threat/`; the sandbox/cage → `src/sandbox/`; per-tool policy rows → `src/tool-policy/`.
**Entry:** `index.ts` is a façade re-exporting `layer/index.ts` and `secrets/index.ts`; import from those barrels (deep imports are allowed only from inside `src/security/`).

## Invariants
- Every file sink (read/write/edit, shell paths, attachments) decides through `evaluateFileAccess` (`layer/file-access.ts`) — one checker so the pre-dispatch gate and the read sink cannot drift.
- Dependency direction is one-way: `layer/` may import `secrets/`; `secrets/` must never import `layer/`.
- `TOOL_PATH_ARGS` (`src/tool-registry.ts`, derived from policy `pathArgs`) names which args are paths; a path-taking tool missing there is a confinement bypass.
- Tool egress URLs go through `evaluateEgressForUrl` / `evaluateWebFetch` (`layer/network-policy.ts`) with the resolved host pinned (`resolveAndPinHost`); never a raw `fetch` for tool egress.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `layer/file-access.ts` | `src/tool-execution/pre-dispatch.ts`, `src/tools/read-imports.ts`, `src/tool-registry.ts` | `layer/file-access.test.ts`, `layer/layer-core-document-confinement.test.ts` |
| `layer/shell-delete-targets.ts` (the one delete extractor: verb, recursive, targets, cwd) | every delete rule reads it: `src/tool-execution/unnamed-delete-gate.ts`, `disposable-tree-delete.ts`, `verify-shell-deletes.ts`, `shell-prelude.ts` (`placeCd`); `layer/shell-path-guard.ts` (task artifacts), `layer/shell-mutation-guard.ts`, `layer/catastrophic-paths.ts`, `layer/rm-inside-workspace.ts` | `layer/shell-delete-targets.test.ts`, `src/tool-execution/unnamed-delete-gate.test.ts`, `src/tool-execution/disposable-tree-delete.test.ts`, `layer/shell-path-guard.task-artifacts.test.ts`, `layer/shell-policy.test.ts` |
| `layer/shell-rules.ts`, `layer/shell-command-rule-table.ts` | `src/tool-execution/shell-approval-tier.ts` | `layer/shell-policy.test.ts`, `layer/shell-command-rules.test.ts` |
| `layer/types.ts` (`WORKTREE_REQUIRED_TOOLS`, `CONTEXT_RESTRICTED_TOOLS` — both derived from the policy rows: capability classes and `deniedIn`) | `layer/layer-core.ts` dispatch | `layer/layer-core-dispatch.test.ts` |
| `layer/types.ts` `WORKER_CONTEXTS` (delegated agents and scheduled jobs answer to one set of rules) | `layer/layer-core.ts` worktree gate, `src/tool-execution/unattended-shell-gate.ts`, the self-verify redirect in `src/tool-execution/enforce-policy.ts` | `layer/layer-core-delegated-worktree.test.ts` (a scheduled job decided exactly as a delegated agent) |
| a worker run's shell containment (`layer/layer-core.ts` `delegatedShellOsContained`: the sandbox's `delegatedShellAllowed`, never a work root) | `src/tool-execution/unattended-shell-gate.ts` reads the same primitive; every provisioner that anchors a work root (`src/agency/agent-workspace.ts`, cron, build-lane workers) relies on the sandbox, not the folder, for containment | `layer/layer-core-delegated-worktree.test.ts` ("bash on an unconfined host is refused even with a work root") |
| `secrets/known-secrets.ts` | `src/tool-execution/` known-secret shell gate, `src/memory/write-safely.ts` redaction | `secrets/known-secrets-email.test.ts`, `src/tool-execution/known-secret-shell-gate.test.ts` |
| `layer/index.ts` / `secrets/index.ts` exports | every `from "../security/index.js"` importer | none |

## Tests
`npx vitest run src/security` (PowerShell on Windows)
