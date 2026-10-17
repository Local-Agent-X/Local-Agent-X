# src/AGENTS.md — core engine rules

Adds to the root [AGENTS.md](../AGENTS.md); it does not replace it. Where this
file and the root disagree, the root wins.

## Protected files

`config/protected-files.json` lists engine files the product agent's `write` /
`edit` / `delete_file` tools refuse outright (`src/tool-execution/resolve-tool.ts`).
Beyond that list, every write anywhere in the install outside `workspace/` is
refused by `src/security/layer/file-access.ts`. `self_edit` is the one route:
it needs `developer_mode` and a git checkout, runs in a worktree, and a change
that touches a protected file is **held for the user to merge by hand**, never
auto-merged (`src/self-edit/sandbox.ts`). Coding agents editing the repo
directly are not subject to any of this.

## Module boundaries

| Module | Owns | Rule |
|---|---|---|
| `canonical-loop/` | the agent turn loop | **Sealed.** Outside code imports only `canonical-loop/index.js` or a `canonical-loop/public/*.js` sub-barrel (`interface-seal.test.ts`). Chat enters via `runChatViaCanonical`; agents, cron and self-edit via `runAgentViaCanonical`; both are exported from `index.ts`. |
| `tool-execution/` | tool-call lifecycle: Ari, policy, approval, RBAC, audit | Every model tool call goes through `executeToolCalls` / `dispatchSingleToolCall`. |
| `tool-policy/` | the per-tool policy table | Default-deny. New entries go in the `tool-policies.<domain>.ts` fragment, never the `.data.ts` barrel. |
| `ari-kernel/` | the in-process security kernel gateway | **Sealed** (`src/module-seals.test.ts`): import `ari-kernel/index.js` (or the `tool-class-map.js` leaf). Don't add a second kernel. |
| `sandbox/` | cage selection + the platform cage backends | **Sealed**: `sandbox/index.js`, `types`, `server-confine`, or a backend leaf (`seatbelt`, `bwrap`, `win-cage*`, `docker-execution-runtime`). |
| `security/` | file access, shell policy, network policy (`layer/`), secret detection (`secrets/`) | All file-access decisions go through `evaluateFileAccess`. |
| `providers/`, `anthropic-client/`, `codex-client/`, `canonical-loop/adapters/` | provider transport | Provider differences stay here; routes never branch on provider. |
| `routes/` | HTTP surface (flat files plus `agents/`, `bridges/`, `browser/`, `chat/`, `settings/`) | Routes call into modules; business logic lives in the module. |
| `memory/` | sqlite-vec + FTS5 hybrid memory, `SessionStore` | One memory store. |

## Invariants

- A sealed module is entered only through its public entries (`src/module-seals.test.ts`, `src/canonical-loop/interface-seal.test.ts`). Export the symbol from the entry; don't widen the row. Any module with a short `AGENTS.md` inside it has its own invariants there.
- Source files import source files with the `.js` suffix; never `dist/`; no `require()` (`check:no-require`; `createRequire` is the sanctioned exception).
- Mutations to shared state broadcast `settings_changed` (see root). A top-level socket frame is a `GlobalFrame` (`chat-ws/frames.ts`) and a bus topic is a key of `EventTopics` (`event-bus.ts`); a new frame type or topic needs its consumer in the same change (`chat-ws/frames.test.ts`, `event-bus-topics.test.ts`).
- External content goes through `sanitize.ts` wrappers before the model sees it.
- A silent `catch {}` needs a comment saying why. The codebase has many without one; don't add more.

## Testing

- `npm run build` must pass; it runs the static checks before `tsc`.
- Tests live beside the code as `*.test.ts` and ship with every behavior change. Run them with vitest (PowerShell on Windows).
