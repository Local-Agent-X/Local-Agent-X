# ops

**Owns:** The operation (op) model for async and delegated work — the `Op` / `ContextPack` / `OpEvent` / `OpCheckpoint` shapes, per-op persistence under the data dir's `operations/<id>/` (`operation.json`, `events.jsonl`, `checkpoint.json`), the session↔op bridge, and the context pack a worker starts from.
**Does not own:** Running an op (the turn loop) → `src/canonical-loop/`; delegation handoff from chat → `src/routes/chat/delegation-handoff.ts`; sub-agent spawning → `src/agents/`.
**Entry:** no index. Public files: `types.ts` (the shared shapes), `op-store.ts` (read/write `operation.json`), `event-log.ts` (append-only per-op events), `session-bridge.ts` (which session submitted which op), `context-pack-builder.ts`.

## Invariants
- `types.ts` is the most-imported module in the repo: a field change reaches the loop, routes, UI event shapes and tests. Find the consumers in `docs/codebase-map.md` before editing.
- `operation.json` is written only on the supervisor side, atomically (tmp + rename) through `op-store.ts`; workers read it from the assign payload and never write it.
- Events are redacted (`redactor.ts`) before `event-log.ts` persists them; the un-redacted event may stream live over WS but never reaches disk.
- `events.jsonl` is what happened; `checkpoint.json` is what resumes. Never rebuild resume state from the event log.
- A context pack carries secret names and grants only, never values.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `types.ts` | consumers in `docs/codebase-map.md` (loop, routes, UI events) | `op-store.test.ts`, `event-log.test.ts` |
| `op-store.ts` layout | `src/canonical-loop/runtime-failover.ts`, `src/routes/chat/run-chat-turn/canonical-run.ts` | `op-store.test.ts` |
| `session-bridge.ts` | `src/canonical-loop/session-bridge-observer.ts` | none |
| `context-pack-builder.ts` | `src/self-edit/agents-rules.ts` (same AGENTS.md walk), `tools/delegated-toolset.ts` | `context-pack-builder.test.ts` |
| `redactor.ts` | `event-log.ts` | `event-log.test.ts` |

## Tests
`npx vitest run src/ops` (PowerShell on Windows)
