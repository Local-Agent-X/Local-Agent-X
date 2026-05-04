# src/AGENTS.md — Core engine rules

You're about to edit the Local Agent X core engine. Stricter rules here than
anywhere else.

## Protected file list

Files listed in `config/protected-files.json` can ONLY be modified via
`self_edit` (which routes around the block intentionally for deep repairs).
Direct `edit`/`write` on those files will be BLOCKED. Don't try to work around
the block — if you need to change protected core, either:
1. Use `self_edit` (the right tool for src/ surgery), or
2. Ask the user.

## Module boundaries

| Module | Owns | Don't touch from elsewhere |
|---|---|---|
| `tool-executor.ts` | tool-call lifecycle, Ari+policy+approval gating | Never bypass to call tools directly |
| `tool-policy.ts` | allow/deny rules + default-deny | New tools need `allow-<name>` rule |
| `ari-kernel.ts` | in-process security layer | Don't add a second one |
| `anthropic-client.ts`, `codex-client.ts`, `agent-providers.ts` | provider-specific streaming | Keep provider differences here, not leaking into routes |
| `agent.ts` | single `runAgent` entry point | All provider routing goes through it |
| `routes/*.ts` | HTTP surface | Business logic lives in top-level modules, routes just call in |
| `memory.ts`, `memory-*.ts` | sqlite-vec hybrid memory | Don't add a second memory store |

## Invariants specific to src/

- **One responsibility per file.** If a file passes ~400 LOC, split before adding more.
- **Tool results must pass through `tool-executor.executeToolCalls`.** That's where Ari, policy, RBAC, approval, and event emission live. Any new tool path that bypasses is a bug.
- **Every new tool needs:** (a) `ToolDefinition` with JSON schema, (b) registration in `tools.ts` `allTools` export, (c) allow rule in `tool-policy.ts`. All three. Missing any → default-deny kicks in.
- **Mutations to shared state must broadcast.** Any `/api/*` POST that changes theme/settings/provider/session must `broadcastAll({ type: "settings_changed", ... })`. Silent writes desync the UI.
- **Never import from `dist/`.** Source files import source files with `.js` suffix (ESM + Node16 resolution quirk).
- **No `require()` in new code.** Package is `"type": "module"` — use dynamic `import()` or top-level ESM imports.
- **Guard external content.** Web/browser/http_request results must flow through `sanitize.ts` wrappers before reaching the model.

## Testing expectations

- `npm run build` must pass. If tsc fails, your change is rejected.
- No silent catch-all `catch {}` unless there's a specific reason in a comment.
- Don't add test files unless the user asked — prefer inline sanity checks.
