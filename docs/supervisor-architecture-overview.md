# Supervisor Architecture — Code Overview

> A code-grounded companion to `docs/supervisor-architecture-spec.md`. The spec
> describes the design; this file maps the design onto the actual files,
> entry points, and tests. Read this when you want to find where something
> lives. Read the spec when you want to understand why.

---

## 1. The spine, in code

| Spec concept                | Where it lives                                | Tests                                |
|-----------------------------|-----------------------------------------------|--------------------------------------|
| Op model + IPC envelopes    | `src/workers/types.ts`                        | (covered indirectly via everything else) |
| Op metadata persistence     | `src/workers/op-store.ts`                     | `test/op-store.test.ts`              |
| Worker pool + dispatcher    | `src/workers/pool.ts`                         | `test/pool.test.ts`                  |
| IPC framing (JSON-lines)    | `src/workers/ipc.ts`                          | `test/ipc.test.ts`                   |
| Heartbeat + circuit breaker | `src/workers/heartbeat.ts`                    | `test/heartbeat.test.ts`             |
| Auto-delegation (chat → op) | `src/workers/auto-delegate.ts`                | `test/auto-delegate.test.ts`         |
| Pending-completion queue    | `src/workers/pending-notifications.ts`        | `test/pending-notifications.test.ts` |
| Streaming tool-call filter  | `src/anthropic-client/parse.ts`               | `test/parse.test.ts`, `test/parse-streaming.test.ts` |
| Context pack builder        | `src/workers/context-pack-builder.ts`         | (no direct tests yet)                |
| Session bridge              | `src/workers/session-bridge.ts`               | (no direct tests yet)                |
| Idle nudge                  | `src/workers/idle-nudge.ts`                   | (no direct tests yet)                |
| Durable event log           | `src/workers/event-log.ts`                    | (no direct tests yet)                |
| Streaming redactor          | `src/workers/redactor.ts`                     | (no direct tests yet)                |

Tests as of 2026-04-30: **235 passing across 8 files.**

---

## 2. Op lifecycle

```
chat message ──→ shouldAutoDelegate?  ──no──→ inline turn (chat agent runs the work)
                       │
                      yes
                       ▼
                delegateMessageToWorker
                       │
                       ▼
            buildContextPack ──→  Op{...}
                       │
                       ▼
                trackOpForSession      (session-bridge remembers who to notify)
                       │
                       ▼
                  submitOp(op)         (pool.ts)
                       │
                       ▼
            ┌──────────────────────────┐
            │  pool dispatcher picks   │
            │  a worker by lane prio   │
            └──────────────────────────┘
                       │
                       ▼
            spawn tsx subprocess + JSON-lines IPC
                       │
                       ▼
            heartbeat ping every 5s; suspect at 30s; dead at 60s
                       │
                       ▼
            worker emits events.jsonl + writes operation.json
                       │
                       ▼
            on completion: pushPendingNotification(sessionId, payload)
                       │
                       ▼
            user sends next message → drainPendingNotifications →
                       │      injects [BACKGROUND] block into system prompt
                       ▼
            chat agent narrates the result
```

Op states: `pending` → `running` → `completed | failed | cancelled`. Stamped
automatically by `setOpStatus()` (op-store.ts) — the comparator there sets
`startedAt` on first transition into `running` and `completedAt` on any terminal
state. See `test/op-store.test.ts` for the round-trip behavior.

---

## 3. Three priority lanes

Defined in `pool.ts` (`LanePriority` map):

| Lane          | Numeric prio | Use                                   |
|---------------|-------------:|---------------------------------------|
| `interactive` | 3            | Voice turns, foreground chat, anything user is staring at |
| `build`       | 2            | App builds, autopilot rounds, user-initiated long tasks |
| `background`  | 1            | Cron missions, memory consolidation, dream cycles |

Two scheduling guarantees:
- **Interactive never starves** — the dispatcher reserves at least one worker
  for the interactive lane.
- **Build never starves background to death** — but background yields if the
  build queue is non-empty.

Auto-delegated chat messages all use lane=`build` (see
`auto-delegate.ts:94`) — they're user-initiated long tasks, not foreground
turns. Voice and direct chat-handler turns use `interactive` and don't go
through the pool at all.

---

## 4. Auto-delegation gate

`shouldAutoDelegate(provider, message, channel)` in `auto-delegate.ts:68`.

The function ANDs four conditions:

1. `channel === "web"` — bridges (telegram, voice, cron) run their own loops.
2. `!SHORT_TASK_RE.test(message.trim())` — no greetings, no <30-char messages.
3. EITHER:
   - `wordCount >= 50`, OR
   - `LONG_TASK_VERB_RE.test(message)` AND (`wordCount >= 15` OR `MULTI_FILE_CUE_RE.test(message)`)

Provider is intentionally ignored — the parameter is kept for future provider-
specific gating but every provider currently delegates the same way.

See `test/auto-delegate.test.ts` (65 tests) for the full coverage matrix —
short-task filter, channel gating, all three verb-phrase entry points,
multi-file cue variants, exact-boundary word counts, case insensitivity.

---

## 5. Pending notifications + re-delegation guard

`pending-notifications.ts` keeps two parallel data structures:

| Map                    | Cap | TTL    | Purpose                                       |
|------------------------|----:|--------|-----------------------------------------------|
| `queues`               |  20 | 24 h   | Drained on next user message → injected into system prompt |
| `completionHistory`    |  30 | 30 min | Survives drain; protects against re-delegation of just-finished ops |

Why two? Without `completionHistory`, the agent that just finished `build the
homepage` would re-delegate it on a follow-up `yo` from the user (because the
queue was already drained and consumed). The history outlives the drain so
`findRecentCompletionMatching` can spot the duplicate and short-circuit.

`prune()` runs inside `pushPendingNotification` and trims both maps in one
pass; empty session entries are deleted from the maps to bound memory.

Tests: `test/pending-notifications.test.ts` (42 tests). Distinct cap and TTL
behavior for queue vs history is covered explicitly.

---

## 6. Streaming tool-call filter

`filterStreamDelta(delta, alreadySuppressing)` in `parse.ts` is a tiny state
machine that runs once per Anthropic stream chunk. Three branches:

- **Already suppressing + close marker** (`` ``` ``, `}\n`, `</tool_use>`,
  `</function_calls>`) → returns `{ text: "" }`.
- **Already suppressing + no close marker** → returns `{ suppress: true }`.
- **Not suppressing + open marker** (`` ```json ``, `{"tool_calls"`,
  `<tool_use>`, `<function_calls>`, bare `` ``` ``) → returns `{ suppress: true }`.
- **Not suppressing + plain prose** → returns `{ text: delta }`.

Consumer (`stream-cli.ts`):

```ts
const cleanDelta = filterStreamDelta(inner.delta.text, suppressing);
if (cleanDelta.suppress) { suppressing = true; }
else if (cleanDelta.text) { suppressing = false; yield ... }
```

> ⚠ Known bug — **#2 in `BUGS-FOUND.md`**: the close-marker branch returns
> `{ text: "" }` and the consumer's `else if (cleanDelta.text)` treats `""` as
> falsy, so `suppressing` never resets. Text after a tool-call block is silently
> dropped. `test/parse-streaming.test.ts` documents the current (buggy)
> behavior; flip those assertions back to expecting `" after"` / `" trailing"`
> to land in the `visible` output once the producer signals the reset.

---

## 7. Heartbeat + circuit breaker

`heartbeat.ts`:

- Every worker pongs to a ping every **5 s**.
- No pong by **30 s** → worker is `suspect`. Pool stops dispatching new ops to
  it, finishes whatever it's running.
- No pong by **60 s** → worker is `dead`. Pool kills the subprocess, requeues
  any in-flight op, spawns a replacement.
- **Circuit breaker** — five consecutive failures of the same op type within
  60 min opens the circuit for that type. New submissions of that type are
  rejected with a circuit-open error until the timer expires.

Retry policy is per op type (`getRetryPolicy` in `heartbeat.ts`). Default:
3 attempts, exponential backoff starting at 1 s, max 30 s.

Tests: `test/heartbeat.test.ts` (21 tests).

---

## 8. IPC framing

`ipc.ts` exposes `sendIpc(stream, msg)` and `receiveIpc(stream)`. Wire format:
JSON object per line, `\n`-terminated. Lines that fail `JSON.parse` are dropped
with a warning (a worker writing free-form text to stdout shouldn't kill the
parser). Tests cover the round-trip + the partial-line buffering invariants in
`test/ipc.test.ts` (19 tests).

---

## 9. Persistent storage layout

```
~/.lax/operations/<opId>/
  operation.json   # Op{} — id, type, task, status, timestamps, retry policy, …
  events.jsonl    # append-only redacted event log (status updates, tool calls)
  artifacts/      # large outputs (full summary, file diffs, screenshots)
```

`op-store.ts` owns `operation.json` (atomic temp-file replace). `event-log.ts`
owns `events.jsonl`. `redactor.ts` strips secrets from event payloads before
they hit disk.

> ⚠ Known bug — **#1 in `BUGS-FOUND.md`**: `listOps()` calls
> `.localeCompare(...)` on the `createdAt`/`startedAt` fields, but at least one
> writer (autopilot, prefix `op_ap_*`) persists those as numbers instead of ISO
> strings. The function throws as soon as it hits a numeric record. Fix: coerce
> with `String(...)` in the comparator, or normalize on read in `readOp()`.

---

## 10. Things not yet covered by tests

These are the gaps a future test round should fill:

- **`pool.ts` integration** — current `test/pool.test.ts` covers the queue and
  event-bus invariants; it does NOT spawn real worker subprocesses. End-to-end
  submit→dispatch→complete needs a real subprocess fixture.
- **`context-pack-builder.ts`** — no direct tests. The pack shape, file
  inclusion rules, and budget enforcement are uncovered.
- **`session-bridge.ts`** — `trackOpForSession` / completion routing is
  exercised indirectly by auto-delegate but never asserted.
- **`event-log.ts` + `redactor.ts`** — durable log path and secret redaction
  have no direct coverage.
- **`idle-nudge.ts`** — proactive "by the way the op finished" path is
  uncovered.
- **`ws-broadcaster.ts`** (chat WS layer) — `pendingNotifications` is consumed
  here on every turn; no test verifies the prepare-request injection currently.

The pattern that's working well: pure-function modules (`auto-delegate`,
`parse`, `heartbeat`-policy, `pending-notifications`) are easy to test
exhaustively. Anything that spawns subprocesses or owns network state needs a
fixture harness we don't have yet.

---

## 11. Where to start when something breaks

| Symptom                                       | First file to read                |
|-----------------------------------------------|-----------------------------------|
| Worker takes forever / never returns          | `heartbeat.ts` (circuit + suspect timing) |
| User saw `null` reply where work happened     | `pending-notifications.ts` (drain semantics) + `prepare-request.ts` (injection) |
| Tool-call markup leaked into chat output      | `parse.ts` (open-marker rules) + `stream-cli.ts` (consumer) |
| Auto-delegate skipped a real long task        | `auto-delegate.ts` (regex/word-count gate) |
| Op completed but agent never narrated         | `session-bridge.ts` + `pending-notifications.ts` (push path) |
| Concurrent submits race / duplicate spawns    | `pool.ts` (FIFO + lane priority) |
| `listOps()` throws                            | `op-store.ts` line 55 → BUG #1 above |

When in doubt: start at the test file. Tests describe the contract more
honestly than the implementation does.
