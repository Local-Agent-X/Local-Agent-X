# LAX Canonical Operation Loop — v1 PRD

**Status:** Design locked, awaiting implementation
**Owner:** Alex
**Last updated:** 2026-05-04

---

## 1. Title

LAX Canonical Operation Loop (v1)

A single execution loop that owns operation lifecycle, state, events, checkpoints, signals, and crash recovery — replacing the fragmented per-adapter/per-lane paths currently behind `op_submit_async`, workers, status, events, cancellation, redirect/pause, checkpoints, and finalization.

---

## 2. Problem Statement

Today, work submitted via `op_submit_async` flows through several de facto paths depending on provider, lane, and entry point. Each path independently reinvents:

- Lifecycle ("running" / "done" / "errored" semantics)
- Event/status emission shape
- Cancellation and abort
- Pause and redirect
- Checkpoint / resume / replay
- Worker leasing and crash recovery

The result is drift between paths, brittle behavior under failure, and the inability to offer systemic guarantees (reconnect replay, mid-stream cancel, crash-safe resume) without reimplementing them per path.

We need one canonical state machine that owns these concerns once, and adapters that bring providers in through a single locked contract.

---

## 3. Goals

- One state machine writing `ops.state`, `op_turns`, `op_messages`, `op_events`.
- One canonical event envelope, persisted in `op_events` with per-op monotonic `seq`.
- One checkpoint model: append-only `op_turns` + `op_messages` + opaque adapter `provider_state`, atomic at turn boundaries.
- One control plane: durable signal columns + lossy fast-path bus + locked `adapter.abort()` contract.
- One worker model: in-process pool, op-level leases, single queue, lane scheduling.
- Crash-safe: lease expiry triggers re-lease and replay from the last committed checkpoint.
- Reconnect-safe: clients reattach via `op_events_since`.
- Two-adapter proof: Anthropic (v1) and Codex (v1.1) both pass the same conformance suite without contract changes.
- Parallel-run safe: existing fragmented paths remain runnable behind a feature flag throughout v1–v1.3.

---

## 4. Non-Goals

- Multi-worker concurrency tuning (single worker per lane in v1; cap=1 for `interactive`).
- Load / performance testing in v1. Correctness first.
- Full UI / E2E coverage. The loop is testable headlessly.
- Cross-op orchestration (parent/child fan-out, batch jobs).
- Touching tool-executor, Anthropic OAuth, memory, provider routing, voice, Codex executor unification, build_app flow, IDE worker session, Ari/policy, secrets storage, sidebar/UI chrome, package dependencies.
- Hard cutover of any path.
- Multi-redirect queueing (v1 is latest-wins).
- Mid-turn checkpoints (long tools handle their own idempotency).
- Token-level persistence (stream chunks are bus-only and ephemeral).

---

## 5. Ubiquitous Language / Glossary

Every PRD line, code identifier, and event type uses these terms with these meanings. Synonyms are bugs.

### operation
- *Definition:* One user-submitted unit of work that the canonical-loop drives from `queued` to a terminal state through one or more turns.
- *Owned by:* Caller submits; canonical-loop owns the lifecycle.
- *Not to be confused with:* turn, tool call, conversation/session.
- *Naming:* `op`, `op_id`, table `ops`, public API prefix `op_*`.

### turn
- *Definition:* One model invocation plus the tool calls it requested and their results, terminated by a post-turn checkpoint commit.
- *Owned by:* Canonical-loop drives turns; adapter executes one turn at a time when called.
- *Not to be confused with:* operation, message, tool call.
- *Naming:* `turn_idx` (monotonic per op, starts at 0), table `op_turns`, events `turn_started` / `turn_committed`.

### tool call
- *Definition:* One invocation of a registered tool requested by the model during a turn, executed by `tool-executor.ts`, surfaced as observability only.
- *Owned by:* `tool-executor.ts` executes; canonical-loop dispatches and records summaries.
- *Not to be confused with:* turn, checkpoint, event.
- *Naming:* events `tool_started` / `tool_finished`; summary array `op_turns.tool_call_summary`.

### loop (canonical-loop)
- *Definition:* The single canonical state machine that owns op lifecycle, state transitions, event emission, checkpoints, signal application, and lease management.
- *Owned by:* Itself — sole writer of `ops.state`, `op_turns`, `op_messages`, `op_events`, and signal-clearing.
- *Not to be confused with:* worker, turn_loop, adapter.
- *Naming:* canonical module name `canonical-loop`. The inner per-turn driver is `turn_loop`. In PRD prose, "loop" means canonical-loop unless explicitly qualified.

### adapter
- *Definition:* A provider-specific module that, given turn input plus opaque `provider_state`, drives one model turn and emits `adapter_report` items back to the loop.
- *Owned by:* Provider I/O — subprocess/CLI, prompt format, stream parse, `provider_state` contents, `abort()`.
- *Not to be confused with:* loop, tool executor, worker, subagent.
- *Naming:* per provider — `anthropic-adapter`, `codex-adapter`. Single canonical contract.

### worker
- *Definition:* An in-process Node async function that holds an op lease and drives the canonical-loop for that op until terminal, paused, cancelled, or lease lost.
- *Owned by:* Worker pool; one op at a time per worker.
- *Not to be confused with:* loop, OS thread/process, subagent.
- *Naming:* `worker_id`, `worker_pool`. Concurrency capped per lane.

### lane
- *Definition:* A scheduling category on the queue (`interactive`, `build`, `ide`, `background`) with its own concurrency cap, governing distribution of ops to workers.
- *Owned by:* Submission API sets it; scheduler reads it.
- *Not to be confused with:* priority, session, queue.
- *Naming:* `lane` column on `ops`; `lane_caps` config.

### lease
- *Definition:* A time-bounded ownership claim by exactly one worker over one op, granted by atomic DB update, refreshed by heartbeat, released on terminal/paused/expiry.
- *Owned by:* DB row is canonical; worker holds the claim.
- *Not to be confused with:* state, lock.
- *Naming:* `lease_owner`, `lease_expires_at` columns on `ops`.

### checkpoint
- *Definition:* An append-only `op_turns` row plus its `op_messages` rows, written atomically at the post-turn boundary; the only resumable point.
- *Owned by:* Canonical-loop writes.
- *Not to be confused with:* event, turn (abstract), `current_checkpoint_id` (denormalized cache).
- *Naming:* `op_turns` table; PK `(op_id, turn_idx)`. Cache: `ops.current_checkpoint_id` / `ops.current_turn_idx`.

### event
- *Definition:* An append-only canonical fact published by the loop into `op_events` and the bus, with per-op monotonic `seq` and one of the locked v1 type names.
- *Owned by:* Canonical-loop emits; consumers read.
- *Not to be confused with:* stream chunk, signal, adapter_report.
- *Naming:* `op_events` table; PK `(op_id, seq)`; types from the locked enum.

### stream chunk
- *Definition:* An ephemeral piece of model token output or progress data delivered on a separate bus channel keyed by `op_id`, never persisted.
- *Owned by:* Adapter produces; bus delivers; nothing stores.
- *Not to be confused with:* event, message, signal.
- *Naming:* bus channel `op_stream:{op_id}`. No table.

### signal
- *Definition:* A durable control intent (pause / cancel / redirect / resume) written to `ops` columns by the public control API, fast-pathed via bus, applied by the loop.
- *Owned by:* Public control API writes; loop reads, applies, clears.
- *Not to be confused with:* event, adapter_report, bus message.
- *Naming:* columns `pause_requested_at`, `cancel_requested_at`, `redirect_instruction`, `redirect_received_at`. No separate signals table in v1.

### provider_state
- *Definition:* Opaque JSON owned by the adapter, written to `op_turns.provider_state` at each commit, read on resume, never parsed by the loop or any other adapter.
- *Owned by:* Single adapter type — Anthropic adapter reads/writes only its own blob; Codex same.
- *Not to be confused with:* messages, checkpoint metadata, tool results.
- *Naming:* column `op_turns.provider_state`, type JSON. Internal envelope: `{ adapter_name, adapter_version, provider_payload }`.

### op_messages
- *Definition:* Append-only canonical message log; one row per finalized conversation message tied to `(op_id, turn_idx)`; used for audit, debug, and replay into adapters.
- *Owned by:* Loop writes; adapters read on resume.
- *Not to be confused with:* stream chunks, `provider_state`, `op_events`.
- *Naming:* table `op_messages`; FK `(op_id, turn_idx)`; role enum `system` / `user` / `assistant` / `tool_result` / `control`.

### op_turns
- *Definition:* Append-only checkpoint table; one row per `(op_id, turn_idx)` committed atomically at turn boundary.
- *Owned by:* Loop writes; loop reads latest to resume.
- *Not to be confused with:* `op_messages`, `op_events`, abstract turn.
- *Naming:* table `op_turns`; PK `(op_id, turn_idx)`; monotonic, no gaps.

### op_events
- *Definition:* Append-only canonical event log; one row per `(op_id, seq)` holding `type`, `body`, `ts`; replayable via `op_events_since(op_id, seq)`.
- *Owned by:* Loop writes; consumers (UI, IDE, status, audit) read.
- *Not to be confused with:* `op_turns`, bus delivery, stream chunks.
- *Naming:* table `op_events`; PK `(op_id, seq)`; seq monotonic per op.

### adapter_report
- *Definition:* An internal report emitted by an adapter upward to the loop during a turn — observations like model token, tool_call, message_finalized, finish_reason, transport error.
- *Owned by:* Adapter emits; loop consumes and translates into canonical events / messages / tool dispatches / state transitions / stream chunks.
- *Not to be confused with:* signal (external control input), event (canonical outgoing fact).
- *Naming:* `adapter_report` (never `adapter_signal`).

### turn_loop
- *Definition:* The inner per-turn driver inside canonical-loop that assembles a prompt, invokes the adapter, dispatches tool calls, and commits the checkpoint.
- *Not to be confused with:* canonical-loop (the system).
- *Naming:* `turn_loop`.

---

## 6. Locked Architecture Decisions

| # | Concern | Decision |
|---|---|---|
| 1 | Boundary | Loop owns lifecycle (state, events, checkpoints, signals, leases). Adapter owns provider I/O only. Tool exec via `tool-executor.ts`. |
| 2 | Lifecycle unit | Op = lifecycle. Turn = checkpoint/resume boundary. Tool call = observability inside a turn. |
| 3 | State machine | 7 states. Turn-phase tags inside `running`, not states. Loop is sole writer. |
| 4 | Worker model | In-process Node worker pool. Op-level lease + heartbeat. Single DB-backed queue table. Lanes with concurrency caps. FIFO within lane. |
| 5 | Checkpoint | Append-only `op_turns` + `op_messages`. Opaque adapter-owned `provider_state`. Atomic post-turn commit. No mid-turn checkpoints in v1. Denormalized `current_turn_idx` / `current_checkpoint_id` on `ops` for fast reads. |
| 6 | Events | One envelope, append-only `op_events`, per-op monotonic `seq`. Persisted events vs ephemeral stream chunks (bus-only). Loop is sole emitter. Reconnect via `op_events_since`. |
| 7 | Control plane | Signal columns on `ops` + lossy fast-path bus. Pause + redirect at turn boundary. Cancel = immediate `adapter.abort()`. Latest-wins redirect. Loop applies and clears. |
| 8 | Migration | v1 Anthropic interactive → v1.1 Codex (boundary proof) → v1.2 build → v1.3 IDE. Parallel-run behind feature flag. No hard cutover. Adapter contract Codex-aware from day one. |
| 9 | Untouchables | Tool-executor, Anthropic OAuth, memory, routing, voice, Codex executor, build_app, IDE session, Ari/policy, secrets, UI chrome, deps. Public API signatures unchanged. Additive schema only. |
| 10 | Tests | 11 v1 acceptance tests + 9-item adapter conformance suite. Fake adapter for loop tests, real Anthropic CLI for smoke. Codex must pass conformance unchanged. Invariant: `ops.state == latest state_changed.to`. |
| 11 | Deletion | Gate: v1.3 + 100% canonical traffic ≥ 2 weeks + zero canonical-attributable incidents + all 20 tests green + no flag-OFF deployments. 10-item manifest, per-concern PRs, permanent "no op escapes canonical" invariant test. |

---

## 7. User Stories

**As a caller (UI / CLI / IDE), I can:**
- Submit work with `op_submit_async` and receive an `op_id` immediately, regardless of which path serves it.
- Stream tokens for an in-flight op via the `op_stream:{op_id}` bus channel.
- Subscribe to canonical events for an op and replay missed events after disconnect via `op_events_since(op_id, seq)`.
- Query current op status and get a consistent shape.
- Pause an in-flight op; the current turn finishes cleanly and no further turns run until I resume.
- Resume a paused op; it picks up from the last committed checkpoint.
- Redirect an in-flight op with a new instruction; the next turn assembles its prompt with that instruction folded in. A second redirect overrides the first if the first hasn't been applied yet.
- Cancel an in-flight op; the adapter is aborted within seconds and the op transitions to `cancelled`.

**As an operator, I expect:**
- A worker crash mid-turn does not lose the op; another worker leases it and replays from the last checkpoint.
- A client disconnect does not lose canonical events; reconnect-and-replay catches up.
- A long tool run inside a turn does not corrupt op state; turns either commit atomically or are replayed.
- Nothing about adapters or providers leaks into consumer code beyond the canonical event surface.

**As a future adapter author, I expect:**
- A single locked contract (`runTurn`, `abort`, `provider_state` round-trip) and a conformance suite I can run against my adapter without modifying the loop.

---

## 8. System Responsibilities

| Component | Responsibility | NOT responsible for |
|---|---|---|
| **canonical-loop** | State transitions; event emission; checkpoint commits; signal intake/application; lease lifecycle; tool dispatch via `tool-executor`; turn_loop orchestration; sole writer of canonical state. | Provider I/O; running tools; UI/transport; routing; auth. |
| **adapter** | Driving one turn given input + provider_state; emitting `adapter_report` items; serializing/restoring `provider_state`; honoring `abort()`. | DB writes; event emission; tool execution; spawning workers; reading other adapters' state. |
| **worker** | Leasing one op; running canonical-loop for that op; heartbeating; releasing lease on terminal/paused/lease-loss. | Defining the loop; writing canonical state directly. |
| **scheduler** | Choosing the next op to lease per lane caps; FIFO within lane. | Mutating op state; running ops itself. |
| **public control API** | Writing `signal` columns on `ops`; publishing fast-path bus signals; never mutating other state. | Applying signals; deciding state transitions. |
| **tool-executor** (existing) | Running tools requested by the loop and returning results. | Touching ops/turns/events; touching adapters. |
| **bus** | Best-effort delivery of canonical events and ephemeral stream chunks; signal fast-path. | Durability (DB owns that). |
| **DB** | Source of truth for ops, turns, messages, events, signals, leases. | Routing; UI; transport. |

---

## 9. Data Model / Schema Additions

**All schema changes are additive.** No drops, no renames, no signature changes to existing tables.

### `ops` (additive columns only)

| Column | Type | Notes |
|---|---|---|
| `lane` | TEXT | One of `interactive` / `build` / `ide` / `background`. Default for legacy callers stays compatible. |
| `lease_owner` | TEXT NULL | Worker ID currently holding the lease, NULL if unleased. |
| `lease_expires_at` | TIMESTAMPTZ NULL | Lease expiry; if past `now()`, op is re-leasable. |
| `pause_requested_at` | TIMESTAMPTZ NULL | Set by `op_pause`; cleared by loop on application. |
| `cancel_requested_at` | TIMESTAMPTZ NULL | Set by `op_cancel`; cleared by loop on terminal. |
| `redirect_instruction` | JSONB NULL | Latest-wins; cleared by loop after `redirect_applied`. |
| `redirect_received_at` | TIMESTAMPTZ NULL | Set with `redirect_instruction`. |
| `current_turn_idx` | INTEGER NULL | Denormalized cache of `MAX(op_turns.turn_idx)` for this op. |
| `current_checkpoint_id` | UUID/BIGINT NULL | Denormalized cache pointer to the latest `op_turns` row. |
| `canonical_flag_value` | BOOLEAN | The flag value captured at submission; immutable for the op's lifetime. |
| `session_id` | TEXT NULL | For `ide` lane sub-pinning; NULL elsewhere. |

Existing columns and indexes are preserved as-is. Existing path consumers ignore new columns.

### `op_turns` (new, append-only)

| Column | Type | Notes |
|---|---|---|
| `op_id` | UUID/TEXT | FK to `ops.op_id`. |
| `turn_idx` | INTEGER | Monotonic per op, starts at 0, no gaps. |
| `provider_state` | JSONB | Opaque to loop. Envelope `{ adapter_name, adapter_version, provider_payload }`. Size cap enforced (PRD detail). |
| `tool_call_summary` | JSONB | Array of `{ tool, args_hash, result_status, duration_ms }`. Observability only. |
| `terminal_reason` | TEXT NULL | One of `done` / `error` / `cancelled` if this turn ended the op; NULL otherwise. |
| `redirect_consumed` | BOOLEAN | True if a pending `redirect_instruction` was applied during this turn. |
| `created_at` | TIMESTAMPTZ | Commit time. |

- PK: `(op_id, turn_idx)`.
- No UPDATE on existing rows. Append-only.
- Loop reads `WHERE op_id=? ORDER BY turn_idx DESC LIMIT 1` to resume.

### `op_messages` (new, append-only)

| Column | Type | Notes |
|---|---|---|
| `message_id` | UUID | PK. |
| `op_id` | UUID/TEXT | FK to `ops`. |
| `turn_idx` | INTEGER | FK reference into `op_turns(op_id, turn_idx)`. |
| `seq_in_turn` | INTEGER | Order within the turn. |
| `role` | TEXT | One of `system` / `user` / `assistant` / `tool_result` / `control`. |
| `content` | JSONB | Canonical message body. |
| `created_at` | TIMESTAMPTZ | |

- Index on `(op_id, turn_idx, seq_in_turn)` for replay.
- No updates after insert.

### `op_events` (new, append-only)

| Column | Type | Notes |
|---|---|---|
| `op_id` | UUID/TEXT | FK to `ops`. |
| `seq` | BIGINT | Monotonic per op, starts at 0, no gaps. |
| `type` | TEXT | One of the locked enum (Section 12). |
| `body` | JSONB NULL | Type-specific payload. |
| `ts` | TIMESTAMPTZ | Emission time. |

- PK: `(op_id, seq)`.
- Index on `(op_id, seq)` for `op_events_since` queries.
- No updates, no deletes.

---

## 10. State Machine

Seven states, written exclusively by canonical-loop. Turn-phase tags (`assembling_prompt`, `awaiting_model`, `streaming`, `executing_tools`, `post_turn`, `loop`) are observability inside `running`, not state-machine states.

```
                            +-------------+
                            |   queued    |
                            +-------------+
                                  |
                       lease (atomic DB update)
                                  v
                            +-------------+
        lease expiry  <-----|   running   |
                            +-------------+
                            /     |      \
                  pause/redirect  |  cancel
                  (turn boundary) |  (immediate)
                           v      v       v
                     +--------+  +------------+
                     | paused |  | cancelling |
                     +--------+  +------------+
                          |              |
                       resume      adapter.abort()
                          v              v
                    queued -> running   +-----------+
                                        | cancelled |
                                        +-----------+

   running --> succeeded   (adapter terminal_reason = done)
   running --> failed      (adapter terminal_reason = error / unrecoverable)
```

### Transitions (all written by canonical-loop, all emit `state_changed`)

| From | To | Trigger |
|---|---|---|
| `queued` | `running` | Worker leases op atomically. |
| `running` | `paused` | `pause_requested_at` non-null at next turn boundary. |
| `running` | `cancelling` | `cancel_requested_at` non-null (immediate, mid-stream). |
| `running` | `succeeded` | Adapter reports `terminal_reason: done`. |
| `running` | `failed` | Adapter reports `terminal_reason: error`. |
| `running` | `queued` | Lease expired (worker death). Re-leasable from last checkpoint. |
| `paused` | `queued` | `op_resume` called. |
| `cancelling` | `cancelled` | `adapter.abort()` resolved; resources released. |

Terminal states (`succeeded`, `failed`, `cancelled`) are absorbing — no further transitions.

**Hard rules:**
- Only canonical-loop writes `ops.state`.
- Lease ownership is the sole write authority for an op; two workers cannot both hold a lease.
- Cancel always wins over pause/redirect.

---

## 11. Checkpoint Model

A checkpoint is one `op_turns` row plus its `op_messages` rows, written in a single transaction at the post-turn boundary.

### What a checkpoint contains

- The completed turn's `provider_state` envelope (opaque, adapter-owned).
- All canonical messages produced during that turn.
- Tool call summary (observability).
- `terminal_reason` if the turn ended the op.
- `redirect_consumed` if a pending redirect was applied.

### Atomic write at turn boundary

In one transaction:
1. Insert `op_turns` row with `turn_idx = current_turn_idx + 1`.
2. Insert all `op_messages` rows for that turn.
3. Update `ops.state` if terminal; otherwise leave at `running`.
4. Update `ops.current_turn_idx` and `ops.current_checkpoint_id` (denormalized cache).
5. Insert `state_changed` and `turn_committed` rows in `op_events`.
6. If a redirect was applied this turn, insert `redirect_applied` and clear `redirect_instruction`.
7. Touch lease heartbeat.

If the transaction fails, the entire turn is uncommitted. A re-leased worker replays that turn from the previous committed checkpoint. The model is called again — accepted cost for crash recovery.

### Resume protocol

1. Worker leases op.
2. `SELECT ... FROM op_turns WHERE op_id=? ORDER BY turn_idx DESC LIMIT 1` → `last`.
3. Worker reads `last.provider_state`, hands the opaque blob to the adapter.
4. Worker reads `op_messages WHERE op_id=? AND turn_idx <= last.turn_idx ORDER BY turn_idx, seq_in_turn` (or only those the adapter requests).
5. Adapter restores context however it sees fit, with no parsing by the loop.
6. Loop drives turn `last.turn_idx + 1`.
7. If `redirect_instruction` is non-null, the next assembled prompt incorporates it and `redirect_applied` is emitted on commit.

### Idempotency

`op_turns` PK `(op_id, turn_idx)` ensures replays cannot double-insert. If a worker died after committing a turn but before clearing in-memory state, re-leasing produces a PK conflict on attempted re-insert; the loop catches this, treats the turn as already committed, and proceeds to `last.turn_idx + 1`.

### Hard rules

- No mid-turn checkpoints in v1. Long tools handle their own idempotency.
- Loop never parses `provider_state`.
- Adapter only reads/writes its own `provider_state` envelope (matches `adapter_name`).
- `turn_idx` gaps are bugs.

---

## 12. Event Model

### Envelope

```
{
  op_id:  UUID/TEXT,
  seq:    INTEGER (per-op monotonic, starts at 0),
  type:   one of the locked enum,
  ts:     TIMESTAMPTZ,
  body:   type-specific JSON | null
}
```

PK `(op_id, seq)`. Append-only.

### Locked v1 event types

| Type | Body shape | Notes |
|---|---|---|
| `state_changed` | `{ from, to, reason }` | Written same transaction as state. |
| `turn_started` | `{ turn_idx }` | Best-effort durable. |
| `turn_committed` | `{ turn_idx, message_count, tool_count }` | Same transaction as turn commit. |
| `tool_started` | `{ turn_idx, tool, args_hash }` | Best-effort durable. |
| `tool_finished` | `{ turn_idx, tool, status, duration_ms }` | Best-effort durable. |
| `message_appended` | `{ turn_idx, role, message_id }` | Pointer; full body in `op_messages`. |
| `redirect_received` | `{ instruction_id }` | Emitted by control API on signal write. |
| `redirect_applied` | `{ turn_idx, instruction_id }` | Same transaction as turn commit. |
| `pause_requested` | `{ actor }` | Emitted by control API. |
| `resume_requested` | `{ actor }` | Emitted by control API. |
| `cancel_requested` | `{ actor }` | Emitted by control API. |
| `lease_acquired` | `{ worker_id }` | Best-effort durable. |
| `lease_lost` | `{ worker_id, reason }` | Best-effort durable. |
| `error` | `{ code, message, retryable }` | Best-effort durable. |

### Persistence rules

- `state_changed`, `turn_committed`, `redirect_applied` are written **in the same transaction** as the underlying state/turn change. Atomic.
- All other events are durable but written best-effort shortly after the underlying action.
- After DB write, publish to bus.

### Stream chunks (separate, ephemeral)

- Channel `op_stream:{op_id}` on the bus only.
- Carry token deltas, partial subprocess output, in-progress tool output.
- Never persisted. Lost on disconnect.

### Reconnect protocol

```
client tracks last seq
on reconnect:
  rows = SELECT * FROM op_events WHERE op_id=? AND seq > ? ORDER BY seq
  apply rows in order
  re-attach to bus channel `op_stream:{op_id}` and event channel
```

### Hard rules

- Only canonical-loop emits canonical events.
- Per-op `seq` only. No global seq.
- No per-type tables. One envelope.
- Tokens are not events.
- Adapters never write to `op_events` directly.

---

## 13. Control Plane

### Public APIs (additive — existing surfaces unchanged)

- `op_submit_async(input, lane?)` → `op_id` (existing, signature preserved; gains optional `lane`).
- `op_pause(op_id, actor)` → ack.
- `op_cancel(op_id, actor)` → ack.
- `op_redirect(op_id, instruction, actor)` → ack.
- `op_resume(op_id, actor)` → ack.
- `op_status(op_id)` → existing shape, additive optional fields.
- `op_events_since(op_id, seq)` → ordered list of events with `seq > given`.

### Signal storage (on `ops`)

- `pause_requested_at`
- `cancel_requested_at`
- `redirect_instruction`
- `redirect_received_at`

DB is source of truth. Bus is fast-delivery hint.

### Worker intake

- **Fast path:** worker subscribes to bus signals for ops it has leased.
- **Slow path:** worker re-reads signal columns at every turn boundary.

### Application semantics

- **Pause (soft only):** at the next turn boundary, transition `running` → `paused`, release lease, clear `pause_requested_at`. Worker exits the op_loop.
- **Redirect (latest-wins):** at next prompt assembly, fold instruction into the prompt; on commit, emit `redirect_applied` and clear `redirect_instruction`.
- **Cancel (immediate, hard):** worker calls `adapter.abort()`. Transition `running` → `cancelling`. When `abort()` resolves, transition to `cancelled`. Partial uncommitted turn is discarded.
- **Resume:** transition `paused` → `queued`. Re-leasing worker reads last checkpoint and any pending `redirect_instruction`.

### Precedence

`cancel` > `pause` > `redirect`. Cancel is never deferred to a turn boundary.

### Hard rules

- Only the public control API writes signal columns.
- Only canonical-loop reads, applies, and clears them.
- Workers and adapters never mutate signals directly.
- Audit lives in `op_events`; no `_applied_at` shadow columns.
- No `op_control_signals` table in v1.

---

## 14. Worker / Lease / Lane Scheduling Model

### Worker pool

In-process Node async functions managed by a per-process worker pool. Concurrency is enforced via lane caps. Workers are not OS threads or processes.

A worker's lifecycle:

```
loop forever:
  op = scheduler.lease_next()           # atomic DB update
  if op is None:
    sleep brief, continue
  emit event lease_acquired
  run canonical-loop.drive(op)          # turn_loop, signals, commits
  release lease (transitions to terminal/paused/queued already done by loop)
```

### Lease semantics

- Acquired by atomic DB update: `WHERE state='queued' AND (lease_owner IS NULL OR lease_expires_at < now())`.
- Lease duration: **30 seconds** (PRD detail).
- Heartbeat interval: **10 seconds** (PRD detail).
- Worker extends `lease_expires_at` on heartbeat.
- Heartbeat miss → another worker can acquire → loop transitions previous worker's op `running` → `queued` (only if not already terminal).
- Re-leasing worker resumes from last committed `op_turns` row.

### Lane caps (defaults)

| Lane | Cap | Notes |
|---|---|---|
| `interactive` | 1 | One worker concurrently in v1. Lifted later if proven needed. |
| `build` | 2 | Higher to support concurrent build_app runs in v1.2. |
| `ide` | 1 per `session_id` | Sub-pinning by session. Different sessions can run concurrently. |
| `background` | 1 | Low-priority work. |

These are defaults; configurable per deployment but unchanged for v1 unless evidence dictates otherwise.

### Scheduling

- Single queue (the `ops` table itself).
- Scheduler picks the next op: any lane under cap, FIFO within lane, oldest `created_at`.
- `ide` lane: also enforces no two ops with the same `session_id` running concurrently.
- No priority within lane in v1.

### Hard rules

- Lease ownership is write authority. Two workers cannot both hold a lease for the same op.
- Workers are in-process; provider isolation lives in adapter-owned subprocesses, not at the worker layer.
- No turn-level queue. Turns are internal to the op_loop.

---

## 15. Adapter Contract

A locked single interface. Codex (v1.1) must pass conformance against this contract without modifications.

### Interface

```ts
interface Adapter {
  readonly name: string                 // e.g. "anthropic" | "codex"
  readonly version: string              // semver string

  runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult>
  abort(): Promise<void>
}

interface TurnInput {
  op_id: string
  turn_idx: number
  messages: CanonicalMessage[]          // replayed by loop from op_messages
  pending_redirect?: RedirectInstruction
  provider_state?: ProviderStateEnvelope // present on resume; absent on cold start
  tools: ToolDescriptor[]               // available tools for this turn
}

interface ProviderStateEnvelope {
  adapter_name: string                  // must match this adapter
  adapter_version: string               // adapter decides compat policy
  provider_payload: any                 // opaque to loop and other adapters
}

type AdapterReport =
  | { kind: "stream_chunk", body: any }            // forwarded to op_stream bus
  | { kind: "tool_call_requested", call: ToolCall } // loop dispatches via tool-executor
  | { kind: "message_finalized", message: CanonicalMessage } // appended to op_messages
  | { kind: "error", code: string, message: string, retryable: boolean }

interface TurnResult {
  provider_state: ProviderStateEnvelope  // new envelope to checkpoint
  terminal_reason?: "done" | "error"     // null/undefined = continue with next turn
}
```

### Adapter responsibilities

- Drive one model invocation given `input`, including any tool call round-trips that belong inside this turn.
- Stream tokens and partial output via `report({ kind: "stream_chunk", ... })`.
- When the model requests a tool, emit `report({ kind: "tool_call_requested", ... })` and await loop dispatch via `tool-executor`. Loop returns the result as a canonical `tool_result` message in the next turn.
- Finalize each completed canonical message via `report({ kind: "message_finalized", ... })`.
- Surface transport errors via `report({ kind: "error", ... })`. Never throw inside `runTurn`'s resolution path for routine failures.
- Return `TurnResult` with new `provider_state` and optional `terminal_reason`.
- Implement `abort()` per contract.

### Adapter `abort()` contract

- Interrupts active model stream, kills subprocess, cancels pending tool wait.
- Releases all resources.
- Idempotent — calling twice is a no-op.
- Safe on already-completed adapter (no throw).
- Resolves only when the adapter is actually stopped.
- No adapter may register without `abort()`.

### Sandbox (boundary)

- Adapter has no DB handle, no `op_events` writer, no worker pool reference.
- Adapter receives only the `report` callback and `TurnInput`. Cannot reach into loop internals.
- Adapter reads/writes only its own `provider_state` envelope (where `adapter_name` matches).

### Conformance suite (locked at v1)

| ID | Test |
|---|---|
| A | Text-only turn (no tools) completes; emits `message_finalized` and `TurnResult`. |
| B | Tool-call turn round-trips through `tool-executor`; adapter consumes results in the next turn. |
| C | Cold start with absent `provider_state` succeeds. |
| D | Resume with prior `provider_state` envelope continues coherently. |
| E | `adapter.abort()` interrupts an active stream within 1 second. |
| F | `adapter.abort()` is idempotent. |
| G | `adapter.abort()` is safe on a completed adapter. |
| H | Transport errors surface as `report({ kind: "error", ... })`, never as exceptions out of `runTurn`. |
| I | Adapter does not write to DB, `op_events`, or worker pool. Verified by sandbox/audit. |

---

## 16. Migration Plan

| Version | Scope | Status |
|---|---|---|
| **v1.0** | Anthropic interactive on canonical-loop. Full control plane (pause/cancel/redirect/resume). All schema, all events, full conformance for Anthropic. Parallel-run behind flag. | Target: first ship. |
| **v1.1** | Codex adapter on canonical-loop. **No contract changes** unless v1.0 revealed a true loop bug. Codex passes the same locked conformance suite. Real proof of provider neutrality. | Immediately after v1.0. |
| **v1.2** | `build` lane + `build_app` adapter on canonical-loop. Exercises lane caps, long-tool semantics, adapter idempotency. | After v1.1 stable. |
| **v1.3** | `ide` lane with `session_id`-pinned scheduling. Exercises per-session cap=1. | After v1.2 stable. |
| **v1.x+** | Voice, additional providers, deletion gate satisfied → manifest deletions begin. | Post-v1.3. |

### Migration constraints

- v1.0 implementation **must not bake in Anthropic-only assumptions** at the loop layer. Anything provider-specific lives inside the Anthropic adapter's `provider_state` and methods.
- Adapter contract is locked at v1.0 ship. Codex (v1.1) adapts to the contract or doesn't ship.
- Old paths must remain runnable through all of v1.0, v1.1, v1.2, v1.3.
- No "while I'm here" refactors; out-of-scope work is logged as follow-ups.

### Out-of-order migration is allowed *only* if blocked by external dependency. Default order is the table above.

---

## 17. Feature Flag / Parallel-Run Strategy

A per-op feature flag selects between legacy execution and canonical-loop. The flag value is captured at op submission and is immutable for the op's lifetime.

### Flag mechanics

- Flag name: TBD at implementation (e.g., `lax.canonical_loop.{lane}`).
- Granularity: per lane + per provider. Allows enabling Anthropic interactive without touching build/IDE.
- Captured value lives on `ops.canonical_flag_value` for audit and routing.
- `op_submit_async` reads the flag at call time and routes accordingly.

### In-flight semantics

- An op started under flag=ON finishes under flag=ON.
- An op started under flag=OFF finishes under flag=OFF.
- **No mid-flight reroute.** Flag flips affect only ops submitted after the flip.

### Default values

- v1.0 ship: flag default OFF; selected callers/lanes opt in via config.
- After bake-in: flag default flipped ON per lane as confidence grows.
- Post-deletion gate: flag and branching deleted entirely (manifest item #9).

### Rollback

- Flip flag default OFF for the affected lane.
- Existing in-flight canonical ops complete normally on canonical-loop.
- New ops route to legacy path until investigation completes.

### Hard rules

- `op_submit_async` return shape is byte-for-byte identical regardless of flag value.
- No caller can detect which path served them by inspecting the response.
- Old paths must remain runnable until the deletion gate is met.

---

## 18. Test Plan

Two suites, locked at v1.

### v1 acceptance tests (11)

All MUST pass for v1.0 to ship. Each runs with a deterministic fake adapter unless noted.

1. **Happy path** — submit → `running` → `succeeded`. Event `seq` monotonic, no gaps. `op_turns`/`op_messages` populated. Denormalized `current_turn_idx` matches `MAX(op_turns.turn_idx)`.
2. **Cancel mid-stream** — cancel during streaming. `adapter.abort()` invoked within 1s. State path `running` → `cancelling` → `cancelled`. Subprocess dead. Partial turn discarded.
3. **Pause at turn boundary** — pause request mid-turn applied at boundary. Transition `running` → `paused`. Lease released. `pause_requested_at` cleared.
4. **Resume from paused** — `paused` → `queued` → `running`. Worker leases, adapter receives prior `provider_state`, op completes.
5. **Redirect at turn boundary** — redirect mid-turn applied at next turn. `redirect_applied` event emitted with same `instruction_id`. `redirect_instruction` cleared.
6. **Latest-wins redirect** — second redirect overrides first when first hasn't applied. Single `redirect_applied` event for the second.
7. **Crash recovery via lease expiry** — kill worker mid-turn. Lease expires. Second worker leases, replays from last `op_turns`, op completes `succeeded`. Audit shows `lease_lost` + `lease_acquired` with different `worker_id`.
8. **Idempotent turn replay** — synthetic case where a worker partially commits. Replay does not double-insert (PK conflict caught). State remains correct.
9. **Reconnect replay** — disconnect at `seq=N`. Op continues. Reconnect with `op_events_since(op_id, N)` returns `N+1..M` in order. Re-attach to bus seamlessly.
10. **Concurrent ops isolation** — submit 5 ops. Each emits ~20 events. Per-op `seq` monotonic 0..K_i, no gaps, no cross-talk. All five `succeeded`.
11. **Old-path compatibility behind flag** — flag OFF: legacy path served, no rows in `op_turns`/`op_messages`/`op_events`, response identical to pre-canonical fixtures. Flag ON: canonical path served, no writes to legacy execution tables. `op_submit_async` return shape byte-for-byte identical in both modes.

### Adapter conformance suite (9)

Locked at v1. Codex (v1.1) and all future adapters must pass without contract changes.

| ID | Test |
|---|---|
| A | Text-only turn |
| B | Tool-call turn through `tool-executor` |
| C | Cold-start empty `provider_state` |
| D | Resume with `provider_state` |
| E | `abort()` active stream within 1s |
| F | `abort()` idempotent |
| G | `abort()` safe after completion |
| H | Transport errors → `error` adapter_report |
| I | Adapter does not write DB / events / spawn workers |

### Test infrastructure

- **Fake adapter**: deterministic, programmable, runs in milliseconds. Drives all 11 acceptance tests + most conformance tests.
- **Real Anthropic CLI smoke**: 3–5 tests gated in CI. Slow but proves real adapter wiring.
- **Crash test harness**: forcibly rejects worker promise + simulates lease expiry.

### Permanent invariant tests

- After every test: `ops.state == latest state_changed.to`.
- After deletion gate: every op produced by `op_submit_async` results in rows in `ops`, `op_turns`, `op_events`. Zero ops escape canonical.

### What v1 testing does NOT cover

- Load / performance.
- Multi-worker stress (cap=1 in v1 interactive).
- Full UI / E2E.

---

## 19. Untouchables / Constraints

### Untouchable systems (call-only, no modification)

- `tool-executor.ts`
- Anthropic OAuth / Claude CLI internals
- Memory system
- Provider routing (`regex-rules.ts`, `llm-classifier.ts`, `router.ts`)
- Voice paths (three-tier sidecars)
- Existing Codex executor unification
- Existing build_app flow
- Existing IDE worker / session flow
- Ari / policy / tool-approval layer
- Secrets storage
- Sidebar / UI chrome (only minimal additive status display if required)
- Package and dependency changes (only if absolutely required for schema/tests)

### Public API compatibility (no breakage)

- `op_submit_async` signature and return shape unchanged.
- `op_status` return shape unchanged; additive optional fields permitted.
- Existing stream/event endpoints continue serving old-path ops.
- No DB drops, no renames, no signature changes on existing surfaces.
- Schema changes are additive only.

### Allowed in v1

- New canonical-loop modules (≤ 400 LOC each).
- New Anthropic adapter module.
- New tables: `op_turns`, `op_messages`, `op_events`.
- Additive columns on `ops`.
- New public APIs (`op_redirect`, `op_resume`, `op_events_since`, missing `op_pause`/`op_cancel` if not present).
- Feature flag routing inside `op_submit_async`.

### Hard rule

- "While I'm here" refactors are banned. Out-of-scope problems are logged as follow-ups.
- If canonical-loop needs something from an untouchable system, canonical-loop adapts; the untouchable system does not change.

---

## 20. Deletion Manifest and Deletion Gate

### Gate (all conditions must hold before any deletion)

1. v1.3 has shipped (IDE lane on canonical-loop).
2. Feature flag default ON for all lanes (`interactive`, `build`, `ide`, `background`).
3. 100% of `op_submit_async` traffic has run through canonical-loop for at least 2 weeks.
4. Zero canonical-loop-attributable production incidents in that window.
5. All 11 v1 acceptance tests green.
6. All 9 adapter conformance tests green for every live adapter.
7. No deployment depends on flag-OFF legacy behavior.

### Manifest (per-concern PRs, in priority order)

1. Legacy `op_submit_async` execution path that bypasses canonical-loop.
2. Per-adapter ad-hoc event/status emission.
3. Per-adapter custom abort/kill code outside `adapter.abort()`.
4. Per-adapter custom running/done/in-memory state tracking.
5. Legacy checkpoint/resume/persistence code outside `op_turns`/`op_messages`.
6. Per-lane bespoke orchestrators that bypass canonical-loop.
7. Legacy cancel/stop/redirect plumbing replaced by signal columns + bus.
8. Duplicate status/event endpoints once canonical `op_status` / `op_events_since` cover all paths.
9. Feature flag and its branching — only after one additional sprint all-canonical with no rollback.
10. Legacy-only DB tables/columns after confirmed unused.

### Do NOT delete

- `tool-executor.ts`
- Anthropic OAuth / Claude CLI internals
- Memory system
- Provider routing
- Voice paths
- Provider-specific adapter logic (the entire point is to keep these — only their non-canonical leakage is removed)

### Process

- One deletion PR per manifest item.
- Each deletion PR re-runs full acceptance + conformance suites.
- Each deletion PR references the manifest item number.
- If deletion reveals a hidden dependency: back out, replace properly, never weaken canonical-loop to make legacy deletion easier.

### Permanent invariant test (added at v1.0, enforced forever)

After cutover, every op produced by `op_submit_async` must:
- Have a row in `ops`.
- Have at least one `op_turns` row, unless terminal-before-first-turn is explicitly represented.
- Have `op_events` rows with monotonic `seq`.
- Have `ops.state` matching the latest `state_changed.to`.
- Have touched no legacy execution write path.

**No op escapes canonical.**

---

## 21. Open PRD-Detail Decisions (with Recommended Defaults)

These are not blocking design questions. Implementation proceeds with these defaults unless the repo proves otherwise.

| Item | Default | Rationale |
|---|---|---|
| `interactive` lane cap | 1 | Single worker proves the loop without multi-worker stress. Lift later with evidence. |
| `build` lane cap | 2 | Allows concurrent build_app runs in v1.2 without amplifying load. |
| `ide` lane cap | 1 per `session_id` | Preserves session-pinned worker invariant from existing IDE flow. |
| `background` lane cap | 1 | Low-priority work runs serially. |
| Lease duration | 30 seconds | Long enough to survive normal turn pauses; short enough that worker death recovers fast. |
| Heartbeat interval | 10 seconds | One-third of lease duration; standard pattern. |
| `op_id` format | UUID v7 if available, otherwise existing format | UUID v7 sorts by time; falls back cleanly. |
| Bus implementation | Existing app pub/sub if present; otherwise in-process `EventEmitter` for v1 | Don't introduce Redis/external bus prematurely. |
| `provider_state` envelope | `{ adapter_name, adapter_version, provider_payload }` | Adapter version lets adapters reject incompatible blobs cleanly. |
| `provider_state` size cap | TBD practical limit (suggested 256 KB) | Fail loudly if exceeded; rejecting bloated state is cheaper than truncation bugs. |
| Flag flip semantics | Captured at submission, immutable for op lifetime, no mid-flight reroute | In-flight ops finish on the path they started. |
| Stream chunk channel | `op_stream:{op_id}` on bus | Separate from canonical event channel. |
| Worker pool size | TBD per deployment, gated by lane caps | Over-provisioning workers is harmless; under-provisioning blocks ops. |
| Event seq type | BIGINT | Avoids overflow concerns even in long-lived ops. |
| `tool_call_summary` JSON shape | `[{ tool, args_hash, result_status, duration_ms }]` | Observability only; not used for resume. |

---

## 22. Definition of Done (v1.0)

v1.0 is shippable when **all** of the following hold:

### Code

- [ ] canonical-loop modules exist, no module > 400 LOC.
- [ ] Anthropic adapter implements the locked contract (`runTurn`, `abort`, `provider_state` envelope).
- [ ] Worker pool with op-level leases and heartbeats exists.
- [ ] Single queue with lane scheduling exists.
- [ ] Public APIs `op_pause`, `op_cancel`, `op_redirect`, `op_resume`, `op_events_since` are live (additive only).
- [ ] Feature flag routing inside `op_submit_async` is live.
- [ ] Schema additions (`op_turns`, `op_messages`, `op_events`, additive columns on `ops`) are migrated.

### Tests

- [ ] All 11 v1 acceptance tests pass (with fake adapter).
- [ ] All 9 adapter conformance tests pass for the Anthropic adapter.
- [ ] Real Anthropic CLI smoke tests pass (3–5).
- [ ] Permanent invariant test (`ops.state == latest state_changed.to`) passes after every test.
- [ ] Old-path compatibility test #11 passes for both flag values.

### Untouchables verified

- [ ] No diff against `tool-executor.ts`, Anthropic OAuth/CLI internals, memory system, provider routing, voice paths, Codex executor, build_app, IDE flow, Ari/policy, secrets, UI chrome, package deps.
- [ ] Public API signatures unchanged.
- [ ] No DB drops or renames.

### Operational

- [ ] Feature flag defaults OFF; opt-in path for canary.
- [ ] Rollback procedure documented (flip flag OFF; in-flight ops complete normally).
- [ ] Crash recovery proven on real worker death (not just simulation) at least once in staging.
- [ ] Reconnect replay proven against a real client at least once in staging.

### Boundary verified

- [ ] Anthropic adapter has no DB handle, no event-writer reference, no worker-pool reference.
- [ ] Loop has no subprocess/child_process import.
- [ ] Adapter audit: searching for `op_events`, `op_turns`, `ops` writes inside the adapter returns zero hits.

### Documentation

- [ ] This PRD is the source of truth for v1.0 through v1.3.
- [ ] Glossary terms used consistently in code identifiers and event types.
- [ ] No code, comment, or commit references competitor products.

---

**End of PRD.**

Subsequent versions (v1.1 Codex, v1.2 build, v1.3 IDE) inherit this PRD; their addenda only describe lane- or adapter-specific test cases and any newly-discovered provider quirks. The canonical contract does not change.
