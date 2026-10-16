# inbox

**Owns:** The user inbox: the durable list of things the app needs to tell the person using it (an agent asking for them, a background or scheduled job's outcome, a tool call an unattended run refused, an available update). The item model, its storage under `<lax data dir>/inbox.json`, retention, dedupe, the `inbox_item` / `inbox_changed` WS frames, and the item builders each producer calls. The bell (`public/js/notifications.js`) is its view; `src/routes/inbox.ts` is its HTTP surface.
**Does not own:** `src/ops/pending-notifications.ts`, which queues op completions for the AGENT's next system prompt, not the user's. Desktop toasts (the bell raises them through `window.desktop`). One-shot boot banners (`src/user-notice.ts`). When a job, escalation or refusal happens: that stays with its owner, which calls one builder here.
**Entry:** `index.ts` — `postToInbox`, `listInbox`, `inboxStore`, `toInboxView`, `resolveInboxWhere`; `producers.ts` — `inboxAgentEscalation`, `inboxJobResult`, `inboxRefusedAction`, `inboxUpdateAvailable`, `inboxUpdateCurrent`.

## Invariants
- An item with `needsYou` stays until the user resolves or dismisses it: retention never prunes it by age or by the cap (`store.ts` `applyRetention`). Everything else goes 30 days after it last changed, and the cap evicts dismissed, then read, then unread, oldest first.
- Dismiss is soft (`dismissedAt`, hidden), so a keyed repeat with identical content stays dismissed; a repeat whose content changed is a new occurrence and reopens the item.
- `key`, `dismissedAt` and `refusedCall` never leave the server: every client-facing path goes through `toInboxView`. `refusedCall` is what phase 2 re-runs on Approve, so it must be complete (tool, args minus `_` keys, session, op, reason) and must never come from a client.
- `postToInbox` never throws: a producer is another subsystem's code path.
- The agent principal cannot reach `/api/inbox` (`src/rbac-agent-denials.ts`): it could otherwise dismiss what it was refused, or forge an item.

## Producers
| Kind | Where it is posted | Dedupe key |
|---|---|---|
| `agent-message` | `src/agents/escalation-core.ts` (an agent's escalation that resolves to the user) | none |
| `job` | `src/canonical-loop/session-bridge-observer.ts` (background ops), `src/cron/cron-service-execute.ts` (scheduled runs), `src/server/handler-events-agent-result.ts` (spawned agents outside a chat) | `op:<id>`, `cron-done:` / `cron-failed:<job>`, `agent-run:<id>` |
| `refused-action` | `src/tool-execution/unattended-refusal.ts` (one function, called by `require-approval.ts`, `secret-env-approval.ts`, `run-sandboxed.ts`) | `refused:<op or session>:<call hash>` |
| `update` | `src/update-service.ts` `checkForUpdate` | `update:<version>` |
| `approval` | none yet (phase 2) | |
| `app-error` | the bell itself, as a tab-local item (never stored here) | |

## Tests
`npx vitest run src/inbox src/routes/inbox.test.ts` (PowerShell on Windows)
