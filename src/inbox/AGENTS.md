# inbox

**Owns:** The user inbox: the durable list of things the app needs to tell the person using it (an agent asking for them, a background or scheduled job's outcome, a call an unattended run parked for their yes, an available update, a one-time notice worth keeping). The item model, its storage under `<lax data dir>/inbox.json`, retention, dedupe, the `inbox_item` / `inbox_changed` WS frames, the item builders each producer calls, and the user's answer to an approval (`approvals.ts`). The bell (`public/js/notifications.js`) and the phone's inbox screen are its views; `src/routes/inbox.ts` is its HTTP surface, and `src/chat-ws/inbox-frames.ts` answers the phone's `inbox_list` / `inbox_read` / `inbox_act` frames through that route's `mutateInbox` / `actOnInbox`.
**Does not own:** `src/ops/pending-notifications.ts`, which queues op completions for the AGENT's next system prompt, not the user's. Desktop toasts (the bell raises them through `window.desktop`). When a job, escalation, deferral or boot notice happens: that stays with its owner, which calls one builder here. How an approved call runs: `src/tool-execution/approved-call.ts` (the route hands it to `approveInboxItem` as the runner). The phone's half of the frames: agentxos `inbox.ts`, vendored at `src/broker-transport/vendor/inbox.ts` (`src/broker-transport/inbox-contract.test.ts` holds the two in step).
**Entry:** `index.ts` — `postToInbox`, `listInbox`, `inboxStore`, `toInboxView`, `resolveInboxWhere`; `producers.ts` — `inboxAgentEscalation`, `inboxJobResult`, `inboxUpdateAvailable`, `inboxUpdateCurrent`, `inboxUserNotice`, `inboxWithheldOutput`; `approvals.ts` — `inboxApprovalRequest`, `approveInboxItem`, `declineInboxItem`, `INBOX_REFUSAL_TEXT`.

## Invariants
- An item with `needsYou` stays until the user resolves or dismisses it: retention never prunes it by age or by the cap (`store.ts` `applyRetention`). Everything else goes 30 days after it last changed, and the cap evicts dismissed, then read, then unread, oldest first.
- Dismiss is soft (`dismissedAt`, hidden), so a keyed repeat with identical content stays dismissed; a repeat whose content changed is a new occurrence and reopens the item. An approval dedupes only while it waits: once answered, the same call parked again asks again.
- `key`, `dismissedAt` and `deferredCall` never leave the server: every client-facing path goes through `toInboxView`. `deferredCall` is what Approve runs, so it is complete (tool, args minus `_` keys, session, op, run, context, the run's caller role, reason) and never comes from a client: the act route takes only an item id and an answer.
- An approval has no expiry. It is answered once: `store.claimApproval` checks it is still open and resolves it in one synchronous read-modify-write, so of two answers (a double click, two tabs) exactly one is claimed and its call runs at most once. The item is resolved BEFORE the call runs.
- `postToInbox` never throws: a producer is another subsystem's code path. A gate whose deferral could not be recorded refuses the call as before.
- The agent principal cannot reach `/api/inbox` (`src/rbac-agent-denials.ts`): it could otherwise dismiss what it was refused, forge an item, or approve its own parked calls. Answering needs operator or user.

## Producers
| Kind | Where it is posted | Dedupe key |
|---|---|---|
| `agent-message` | `src/agents/escalation-core.ts` (an agent's escalation that resolves to the user) | none |
| `job` | `src/canonical-loop/session-bridge-observer.ts` (background ops), `src/cron/cron-service-execute.ts` (scheduled runs), `src/server/handler-events-agent-result.ts` (spawned agents outside a chat), `approvals.ts` (an approved call's outcome). A finished run's `link.url` is where its result opens: the op's result URL (`src/canonical-loop/session-bridge-extractors.ts` `resultUrlOfOp`, reached through `src/canonical-loop/public/op-facts.ts`: a built app, the newest document it created, a scheduled job's latest report), rendered by the bell as the item's Open link | `op:<id>`, `cron-done:` / `cron-failed:<job>`, `agent-run:<id>`, `approval-result:<item id>` |
| `approval` | `src/tool-execution/deferred-call.ts` (one function, called by `require-approval.ts`, `secret-env-approval.ts`, `run-sandboxed.ts`) | `approval:<cron:job, else op or session>:<call hash>` |
| `update` | `src/update-service.ts` `checkForUpdate` | `update:<version>` |
| `notice` | `src/user-notice.ts` `drainUserNotices` (a notice a migration recorded at boot, e.g. the spend-cap defaults); `src/tools/shell-tool.ts` and `src/tools/process-session.ts` (the output of a command that worked on a vault secret's value in its own text, delivered to the user instead of the model: `inboxWithheldOutput`) | `notice:<notice id>`, `withheld:<tool call or process session id>` |

The bell also renders tab-local `app-error` items (a UI action in that tab that failed); they are never stored or sent, so they are not a kind here.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `DeferredCallRecord` (`types.ts`) | what `deferred-call.ts` records and what `approved-call.ts` dispatches from it | `src/tool-execution/deferred-call.test.ts`, `src/tool-execution/approved-call.test.ts` |
| the cron session id format (`src/cron/cron-session.ts`) | the per-job approval key | `src/tool-execution/deferred-call.test.ts` |

| the `InboxItem` / `InboxFrame` shapes (`types.ts`) | the phone contract (agentxos `inbox.ts`): within a protocol version, only add | `src/broker-transport/inbox-contract.test.ts` (compile-time) |

## Tests
`npx vitest run src/inbox src/routes/inbox.test.ts src/routes/inbox-act.test.ts src/chat-ws/message-router.inbox.test.ts src/broker-transport/inbox-contract.test.ts src/user-notice.test.ts test/notifications-inbox.test.ts` (PowerShell on Windows)
