# canonical-loop — module map

Source of truth: [docs/canonical-loop-prd.md](../../docs/canonical-loop-prd.md).

This directory is the canonical-loop runtime — one state machine that owns
op lifecycle, events, checkpoints, signals, and crash recovery (PRD §6
Decision #1). Adapters live alongside (e.g., `anthropic-adapter`,
`codex-adapter`); this dir is provider-neutral.

## Files

| File | Role | LOC limit |
|---|---|---|
| `index.ts` | Public entry — exports + `canonicalLoopEntry()` (the seam `op_submit_async` calls when the canonical flag is ON for the lane). | ≤ 400 |
| `types.ts` | Canonical-state, lane, event, op-fields, turn-row, message-row, provider-state-envelope shapes (PRD §5 / §9). | ≤ 400 |
| `schema.ts` | On-disk paths under `~/.lax/operations/<opId>/` — canonical-events.jsonl, op-turns/, op-messages.jsonl. | ≤ 400 |
| `store.ts` | Append-only writers/readers for `op_events`, `op_turns`, `op_messages`. Sole disk gateway. | ≤ 400 |
| `feature-flag.ts` | Env-driven per-lane flag reader (`lax.canonical_loop.{lane}`, PRD §17). | ≤ 400 |
| `router.ts` | Pure submit-time routing decision (legacy vs canonical). | ≤ 400 |
| `bus.ts` | In-process pub/sub bus. Channels: `op_events:{opId}` (durable mirror) + `op_stream:{opId}` (ephemeral). | ≤ 400 |
| `event-emitter.ts` | `emit()` = append to `op_events` + publish to bus. `publishStreamChunk()` = bus only. | ≤ 400 |
| `state-machine.ts` | Sole writer of `op.canonical.state`. Validates transitions, emits `state_changed`. | ≤ 400 |
| `tool-dispatch.ts` | `ToolDispatcher` boundary — loop never executes tools itself. Default = no-op; production wiring delegates to `tool-executor.ts`. | ≤ 400 |
| `runtime.ts` | Adapter-factory and tool-dispatcher registry singletons. | ≤ 400 |
| `checkpoint.ts` | `commitTurn()` — atomic post-turn write (op_messages + op_turns + canonical events + terminal-state transition). | ≤ 400 |
| `turn-loop.ts` | `driveTurn()` — inner per-turn driver. Calls adapter, fans tool calls, commits. | ≤ 400 |
| `worker.ts` | `runWorker()` — leases an op, drives the turn_loop until terminal, releases. | ≤ 400 |
| `scheduler.ts` | Single in-process queue + per-lane caps. `enqueueOp` / `pumpScheduler` / `awaitIdle`. | ≤ 400 |
| `adapter-contract.ts` | Locked PRD §15 adapter interface (`Adapter`, `TurnInput`, `AdapterReport`, `TurnResult`) + sandbox import deny-list. Type-only. | ≤ 400 |
| `contract-types.ts` | Value-shape types referenced by the adapter contract (`CanonicalMessage`, `ToolCall`, `ToolDescriptor`). Type-only. | ≤ 400 |
| `control-api.ts` | Public control API surface: `opEventsSince()` reconnect replay, `subscribeOpEvents()` / `subscribeOpStream()` live subscribers, `reconnectOp()` replay+subscribe with seq-dedup, `opPause()` / `opResume()` (Issue 05), `opCancel()` (Issue 06), `opRedirect()` (Issue 07). | ≤ 400 |
| `signals.ts` | Bus-side fast-path control signals — `signalChannel(opId)` channel naming, `publishSignal()` (control-API only), `subscribeOpSignals()` for workers / observers. Durable signal columns on the op are still the source of truth. | ≤ 400 |
| `cancel-handler.ts` | Worker-side cancel primitives (Issue 06): `startCancelTracker`, `finalizeCancel`, `applyPreLeaseCancel`, `applyBoundaryCancel`. Drives `adapter.abort()` with a 1s race timeout; skips commit on partial turns. | ≤ 400 |
| `lease.ts` | Op-level lease primitives (Issue 08): `acquireLease`, `heartbeatLease`, `releaseLease`, `isLeaseExpired`, `LeaseConfig` (defaults 30s/10s, configurable for tests). Sole writer of `leaseOwner` / `leaseExpiresAt`. | ≤ 400 |
| `recovery.ts` | Crash-recovery orchestration (Issue 08): `recoverStaleOp` evicts the dead worker, clears the expired lease, emits `lease_lost reason="expired"`, and routes `running → queued` (re-enqueue) or `cancelling → cancelled` (terminal). | ≤ 400 |
| `adapters/anthropic.ts` | Production Anthropic adapter (Issue 09). Implements the locked PRD §15 contract: streams text/tool-calls/errors, maps to canonical adapter_reports, finalizes assistant messages, returns provider_state envelope (256 KB cap). Sandbox-clean — no DB, no events writer, no `child_process`. | ≤ 400 |
| `adapters/anthropic-transport.ts` | Default transport that wraps `streamAnthropicResponse` (CLI proxy / direct API path) and `getAnthropicApiKey`. Translates provider stream events → canonical `TransportEvent`s. Lives outside the audited adapter file so subprocess primitives don't leak into the adapter surface. | ≤ 400 |

## Boundaries

| Concern | Owner | Forbidden |
|---|---|---|
| Writing `op_events` | `event-emitter.ts` (via `store.ts`). | Adapters, scheduler, worker outside `state-machine.ts`/`turn-loop.ts`/`checkpoint.ts`. |
| Writing `op.canonical.state` | `state-machine.ts`. | Everywhere else. |
| Writing `op_turns` / `op_messages` | `checkpoint.ts` (via `store.ts`). | Adapters, scheduler. |
| Provider I/O | per-provider adapters (NOT in this dir). | Loop itself; `child_process` is forbidden in canonical-loop modules. |
| Tool execution | `tool-executor.ts` via injected `ToolDispatcher`. | Loop / adapter / worker direct execution. |
| Public-control signals | `op_*` public APIs (Issue 05+). | Loop never writes signal columns. |

## Issue 03 happy-path event sequence (single text-only turn)

```
seq=0  state_changed   { from: null, to: "queued",   reason: "submitted" }
seq=1  lease_acquired  { workerId }
seq=2  state_changed   { from: "queued",  to: "running", reason: "leased" }
seq=3  turn_started    { turnIdx: 0 }
seq=4  message_appended{ turnIdx: 0, role: "assistant", messageId }
seq=5  turn_committed  { turnIdx: 0, messageCount, toolCount }
seq=6  state_changed   { from: "running", to: "succeeded", reason: "turn_done" }
seq=7  lease_lost      { workerId, reason: "released" }
```

Stream chunks are NOT in this list — they ride `op_stream:{opId}` only and
are never persisted to `op_events` (PRD §12).

## Issue 04 — Reconnect / event replay

`op_events` is durable; `op_stream:{opId}` is ephemeral. Clients survive
disconnects by tracking the seq of the last canonical event they received
and replaying everything after it on reconnect.

### Reconnect protocol (PRD §12)

```
client tracks last_seq                             // -1 == "from the start"
on reconnect:
  rows = opEventsSince(op_id, last_seq)            // disk read, seq-ordered
  apply rows in order                              // rebuild local state
  re-attach to bus channel `op_events:{op_id}`     // canonical events
  re-attach to bus channel `op_stream:{op_id}`     // stream chunks (live tail only)
```

`reconnectOp(opId, sinceSeq, listener)` packages all three steps into one
call: it subscribes to the bus first, replays disk events with `seq >
sinceSeq` in order, then drains any events that arrived during replay
deduplicated by seq. Each event reaches the listener exactly once.

### Public surface (control-api.ts)

| Function | Purpose |
|---|---|
| `opEventsSince(opId, sinceSeq)` | Pure replay. `sinceSeq = OP_EVENTS_FROM_BEGINNING` (`-1`) returns full history. `sinceSeq >= MAX(seq)` returns `{ ok: true, events: [] }`. Unknown op → `{ ok: false, code: "unknown_op" }`. |
| `subscribeOpEvents(opId, listener)` | Live canonical-event subscription only (no replay). Returns unsubscribe. |
| `subscribeOpStream(opId, listener)` | Live stream-chunk subscription only (no replay — chunks are ephemeral by design). Returns unsubscribe. |
| `reconnectOp(opId, sinceSeq, listener)` | Replay + live subscription with seq-dedup. Returns `{ ok, latestReplayedSeq, off }`. |

### Invariants enforced by tests (Issue 04)

- Per-op `seq` is monotonic 0..N with no gaps.
- Different ops' seq spaces are independent.
- Stream chunks never appear in `op_events_since` results.
- Replay works against terminal ops (final state already on disk) and
  running ops (events still being appended) identically.

## Issue 05 — Pause / resume

Public control APIs:

| Function | Purpose |
|---|---|
| `opPause(opId, actor)` | Soft-pause request. Writes `pause_requested_at` on the op, emits `pause_requested`, publishes a fast-path message on `op_signals:{opId}`. Idempotent on already-paused ops AND on ops that already have a pending pause request. |
| `opResume(opId, actor)` | Resume from `paused`. Emits `resume_requested`, transitions paused→queued (which emits `state_changed`), enqueues + pumps the scheduler so a worker leases the op again. The next adapter call sees the prior `provider_state` from the last `op_turns` row (PRD §11). |

Result envelope: `{ ok: true } | { ok: false, code: "unknown_op" \| "invalid_op_id" \| "terminal" \| "not_paused", message }`.

### Pause is soft (turn-boundary only)

There are no mid-turn pauses in v1. The worker checks `pause_requested_at`
ONLY between turns, after a turn commits. This means:

- A `running` op continues its current turn to completion.
- After commit, the worker re-reads the op from disk, sees the durable
  signal, transitions running→paused, clears `pause_requested_at`, and
  releases the lease.
- A `pause_requested` event always precedes the `state_changed running→paused`
  event in seq order.

### Cancel beats pause beats redirect (PRD §13 precedence)

The turn-boundary handler checks `cancel_requested_at` first; if set, it
skips the pause path entirely and lets cancel handling take over (Issue 06
implements that branch — for now the worker just continues looping if a
cancel-only signal lands).

### Resume protocol

```
opResume(opId, actor):
  emit  resume_requested
  emit  state_changed { from: paused, to: queued, reason: "resumed" }   // via state-machine
  enqueueOp + pumpScheduler                                              // scheduler picks up the op
  // worker leases again, transitions queued→running, drives next turn
  // adapter receives prior provider_state from last op_turns row
```

### Issue 05 events

| Event | Body shape | Emitted by |
|---|---|---|
| `pause_requested` | `{ actor }` | `opPause()` (control API) |
| `resume_requested` | `{ actor }` | `opResume()` (control API) |
| `state_changed` (running→paused) | `{ from: "running", to: "paused", reason: "pause_at_turn_boundary" }` | worker turn-boundary handler |
| `state_changed` (paused→queued) | `{ from: "paused", to: "queued", reason: "resumed" }` | `opResume()` via state-machine |

The locked v1 enum already includes `pause_requested` and `resume_requested`
(PRD §12) — Issue 05 just lights them up.

## Issue 06 — Cancel (mid-stream, hard cancel)

Public control API:

| Function | Purpose |
|---|---|
| `opCancel(opId, actor)` | Hard-cancel request. Read-modify-writes `cancel_requested_at` on the op (preserving pause/redirect signals), emits `cancel_requested`, publishes a `CancelSignal` on `op_signals:{opId}`. Idempotent on `state==="cancelling"` AND on ops that already have a pending cancel request. |

Result envelope: `{ ok: true } | { ok: false, code: "unknown_op" \| "invalid_op_id" \| "terminal", message }`.

### Cancel is mid-stream, not turn-boundary

The worker subscribes to `op_signals:{opId}` for the duration of a lease.
When a `CancelSignal` arrives, the handler runs synchronously inside the
publish chain:

1. flips `tracker.cancelled = true`;
2. immediately transitions `running → cancelling` (PRD §13: "do not wait
   for adapter.abort() to resolve");
3. calls `adapter.abort()` and races it against a 1s timeout.

Once abort resolves (or the timeout fires) `finalizeCancel` clears
`cancel_requested_at` on disk and transitions `cancelling → cancelled`.
The partial turn is discarded — `driveTurn` checks `tracker.cancelled`
after the adapter resolves and returns BEFORE `commitTurn`. No `op_turns`
row, no `op_messages`, no `turn_committed` event.

### Precedence (PRD §13)

`cancel > pause > redirect`. Concretely:

- The cancel **bus signal handler** fires immediately on receipt and
  preempts everything else.
- The **per-iteration boundary check** (after a turn commits) checks
  `cancel_requested_at` BEFORE `pause_requested_at`. A boundary cancel
  goes through `applyBoundaryCancel` (running → cancelling → cancelled
  with adapter.abort()) and skips the pause path entirely.
- A **pre-lease cancel** (cancel set before any worker leases the op)
  routes directly `queued → cancelled` via `applyPreLeaseCancel` — no
  `lease_acquired`, no `running` state, no turn ever started.

### Issue 06 events

| Event | Body shape | Emitted by |
|---|---|---|
| `cancel_requested` | `{ actor }` | `opCancel()` (control API) |
| `state_changed` (running → cancelling) | `{ from: "running", to: "cancelling", reason: "cancel_requested" }` | cancel-handler signal subscriber (mid-stream) OR `applyBoundaryCancel` (race-defensive) |
| `state_changed` (cancelling → cancelled) | `{ from: "cancelling", to: "cancelled", reason: "adapter_aborted" }` | `finalizeCancel` after abort/timeout |
| `state_changed` (queued → cancelled) | `{ from: "queued", to: "cancelled", reason: "cancel_before_lease" }` | `applyPreLeaseCancel` |
| `lease_lost` | `{ workerId, reason: "cancelled" }` | worker `finally` block |

### Happy-path cancel event sequence (cancel mid-turn)

```
seq=0  state_changed   { from: null,        to: "queued",     reason: "submitted" }
seq=1  lease_acquired  { workerId }
seq=2  state_changed   { from: "queued",    to: "running",    reason: "leased" }
seq=3  turn_started    { turnIdx: 0 }
       (... ephemeral stream chunks on op_stream:{opId}, NOT in this log ...)
seq=4  cancel_requested      { actor }                                              ← opCancel
seq=5  state_changed   { from: "running",   to: "cancelling", reason: "cancel_requested" }   ← signal handler
seq=6  state_changed   { from: "cancelling",to: "cancelled",  reason: "adapter_aborted" }    ← finalizeCancel
seq=7  lease_lost      { workerId, reason: "cancelled" }
```

No `turn_committed` event for the aborted turn. No `op_turns/0.json` row.

## Issue 07 — Redirect (latest-wins, turn-boundary)

Public control API:

| Function | Purpose |
|---|---|
| `opRedirect(opId, instruction, actor)` | Latest-wins redirect. Direct-writes `redirect_instruction` (UUIDed envelope `{ instructionId, text, receivedAt }`) and `redirect_received_at` on the op, emits `redirect_received` with the new `instructionId`, publishes a `RedirectSignal` on `op_signals:{opId}`. A subsequent call before the prior redirect applies overwrites it on disk; both `redirect_received` events are durable, but only one `redirect_applied` ever fires per consumed redirect. |

Result envelope: `{ ok: true } | { ok: false, code: "unknown_op" \| "invalid_op_id" \| "invalid_instruction" \| "terminal", message }`.

### Redirect is turn-boundary (next prompt assembly)

There is no mid-turn redirect application in v1. The fold-in happens in
`turn_loop.driveTurn` BEFORE the adapter runs:

1. `driveTurn` snapshots `redirect_instruction` from disk at prompt-assembly
   time (latest-wins: a later overwrite wins as long as it lands before
   this read).
2. The snapshot is passed as `TurnInput.pendingRedirect` (PRD §15
   adapter contract). The adapter folds it into its provider-specific
   prompt format.
3. After the turn commits, `commitTurn` emits `redirect_applied { turnIdx, instructionId }`,
   sets `op_turns.redirect_consumed = true`, and clears `redirect_instruction`
   from the op — but **only if the disk's current `instructionId` still
   matches the one we applied**. If a newer opRedirect landed mid-turn,
   the new instruction stays on disk for the next prompt. The applied
   id still gets its single `redirect_applied` event.

### Precedence with cancel and pause (PRD §13)

`cancel > pause > redirect`. Concretely:

- A pending cancel at the worker's per-iteration boundary check is taken
  BEFORE redirect or pause — the next turn (which would have folded the
  redirect) never starts. The redirect column survives on the cancelled
  op as a benign orphan; nothing applies it.
- Redirect and pause coexist. A redirect set during a paused window
  survives the pause→resume cycle (worker's pause handler clears only
  `pause_requested_at`) and is folded into the first turn after resume.

### Issue 07 events

| Event | Body shape | Emitted by |
|---|---|---|
| `redirect_received` | `{ actor, instructionId }` | `opRedirect()` (control API). One per call, even when latest-wins overwrites. |
| `redirect_applied` | `{ turnIdx, instructionId }` | `commitTurn()` (Issue 07 wiring). Same transaction as `turn_committed`. Exactly one per consumed redirect. |

The locked v1 enum already includes `redirect_received` and `redirect_applied`
(PRD §12) — Issue 07 just lights them up.

### Latest-wins audit trail (PRD acceptance #6)

Two `opRedirect` calls in quick succession on the same op:

- Both calls emit `redirect_received` (durable on `op_events`, distinct
  `instructionId` per call).
- Disk's `redirect_instruction` ends as the second call's envelope.
- The next turn folds in only the second instruction.
- Exactly one `redirect_applied` fires, with the second `instructionId`.
- The first instruction is not re-emitted and not consumed.

## Issue 08 — Lease heartbeat + crash recovery

Lease lifecycle (PRD §14):

| Primitive (`lease.ts`) | Purpose |
|---|---|
| `acquireLease(opId, workerId)` | Atomic-ish acquire. Steals only an EXPIRED lease; returns false if a fresh lease is held by another worker. Persists via `persistOpKeepingSignals` so control-API columns are not clobbered. |
| `heartbeatLease(opId, workerId)` | Refresh `leaseExpiresAt` to `now + leaseDurationMs`. Returns false if the lease was stolen — worker treats this as "abort the in-flight turn". |
| `releaseLease(opId, workerId)` | Idempotent release; no-op if another worker took the lease (recovery path). Worker `finally` blocks use the return value to decide whether to emit `lease_lost`. |
| `setLeaseConfig({ leaseDurationMs, heartbeatIntervalMs })` | Test hook. Defaults: 30s / 10s (PRD §21). |

Heartbeat is a `setInterval` started inside `worker.drive()`. On heartbeat
failure (lease stolen) the worker calls `adapter.abort()` and exits the
turn loop without committing the partial turn.

### Resume protocol uses `op_turns`, not the cache

`worker.drive()` now derives the starting `turnIdx` from
`readLatestOpTurn(opId).turnIdx + 1` (the source of truth) rather than
`op.canonical.currentTurnIdx` (a denormalized cache that can lag a crash).
A worker that committed a turn but died before the cache update no
longer drives the same turn twice.

### Idempotent commit (`checkpoint.ts`, PRD acceptance #8)

`commitTurn` checks `readOpTurn(opId, turnIdx)` first. If the row exists
the call is a replay — it skips message appends, event emission, and
state transitions, and returns `{ inserted: false, messages: [] }`. The
caller advances to the next turn. PK conflict on `(op_id, turn_idx)`
cannot produce duplicate `op_turns` rows, duplicate `op_messages`, or
duplicate `turn_committed` events.

### Recovery (`recovery.ts`)

```
recoverStaleOp(opId):
  read op
  guard:  state ∈ {running, cancelling}, lease present, lease expired
  evict   stale worker from scheduler.active (frees the lane slot)
  clear   leaseOwner / leaseExpiresAt  ← persistOpKeepingSignals
  emit    lease_lost { workerId, reason: "expired" }
  if state === cancelling:
      transition cancelling → cancelled  (cancel always wins, PRD §13)
  else:
      transition running → queued        (state-machine emits state_changed)
      enqueue + pump scheduler            (replacement worker leases)
```

Bulk variant `recoverStaleOps(opIds)` exists for janitor sweeps; the
in-process v1 does not auto-run a janitor — callers (or tests) trigger
recovery explicitly. Filesystem-backed v1 has no DB row-level guard, so
recovery is the loop's authoritative way to take ownership back from a
dead worker.

### Issue 08 events

| Event | Body shape | Emitted by |
|---|---|---|
| `lease_acquired` | `{ workerId }` | worker on lease take (existing). |
| `lease_lost` (worker exit) | `{ workerId, reason }` | worker `finally` ONLY when it still owned the lease. |
| `lease_lost` (recovery) | `{ workerId, reason: "expired" }` | `recoverStaleOp` before transitioning state. |
| `state_changed` (running → queued) | `{ from: "running", to: "queued", reason: "lease_expired" }` | `recoverStaleOp` via state-machine. |
| `state_changed` (cancelling → cancelled) | `{ from: "cancelling", to: "cancelled", reason: "lease_expired_during_cancel" }` | `recoverStaleOp` via state-machine. |

The locked v1 enum already contains `lease_acquired` and `lease_lost`
(PRD §12) — Issue 08 lights up the `lease_lost reason="expired"` and the
`lease_expired` state-change reasons.

### Crash recovery happy path (PRD acceptance #7)

```
Worker A acquires lease. Drives turn 0, commits.
Worker A's adapter hangs on turn 1.
Worker A's heartbeat is paused (process death simulation).
Lease expires.
recoverStaleOp(opId):
    lease_lost { workerId: A, reason: "expired" }
    state_changed { from: "running", to: "queued", reason: "lease_expired" }
    enqueue + pump
Worker B leases:
    lease_acquired { workerId: B }
    state_changed { from: "queued", to: "running", reason: "leased" }
Worker B reads op_turns[0], drives turn 1 with prior provider_state,
    commits, succeeds.
    state_changed { from: "running", to: "succeeded", reason: "turn_done" }
    lease_lost { workerId: B, reason: "released" }
```

Per-op event seq stays monotonic across the recovery boundary; turn 0
is not re-driven, not re-committed, not re-emitted.

## Issue 09 — Anthropic adapter (production conformance)

`AnthropicAdapter` (`adapters/anthropic.ts`) is the first real-provider
adapter against the locked v1 contract (PRD §15). It is the reference
implementation for future adapters (Codex v1.1, build_app v1.2, IDE v1.3).

| Concern | Where | Notes |
|---|---|---|
| Adapter surface | `adapters/anthropic.ts` | `runTurn` + `abort` only. No DB / event-writer / worker-pool / `child_process` imports — verified by conformance item I against `FORBIDDEN_ADAPTER_IMPORTS`. |
| Subprocess / OAuth / stream parse | `adapters/anthropic-transport.ts` | Wraps `streamAnthropicResponse` and `getAnthropicApiKey`. Lives outside the audited adapter file so the sandbox boundary stays clean. |
| Token resolution | `defaultAnthropicTransport` | Lazy — fetched at first stream call. Token is held in transport closure, NEVER passed to the canonical loop, NEVER appears in `provider_state` or events. |
| Injectable transport | `AnthropicAdapterOptions.transport` | Tests inject a programmable mock without touching subprocess primitives. |

### Streaming → canonical mapping

| Provider event | Canonical adapter_report | Notes |
|---|---|---|
| `text { delta }` | `stream_chunk { delta }` | Bus-only, ephemeral. Also accumulated in-memory and finalized as a single `assistant` `message_finalized` at end of turn. |
| `tool_call { id, name, arguments }` | `tool_call_requested { call }` | Loop dispatches via `tool-executor`; tool result rides back as a `tool_result` canonical message in the next turn (Issue 03 contract). |
| `error { code, message }` | `error { code, message, retryable }` | Routine errors NEVER throw out of `runTurn` (PRD §15 H). Secrets scrubbed via regex-based redaction before the report fires. |
| `done { stopReason }` | (not surfaced as a report) | Stop reason is recorded in `provider_state.providerPayload.stopReason`. |

### `provider_state` envelope

```ts
{
  adapterName: "anthropic",
  adapterVersion: "1.0.0",
  providerPayload: {
    lastTurnIdx,                  // sanity marker
    finalizedMessageId | null,    // pointer to op_messages row
    stopReason | undefined,
    pendingTools                  // 0 if turn naturally completed
  }
}
```

Intentionally minimal — the canonical loop replays messages on every
turn, so the adapter doesn't need to remember a conversation id. The
**256 KB size cap** (PRD §21) is enforced before return; oversize fails
loudly with an `error` adapter_report (`code: "provider_state_oversize"`)
and `terminalReason: "error"` rather than silent corruption.

### Abort lifecycle

- `runTurn` mints a fresh `AbortController` per turn so the adapter
  instance is reusable across resume turns (conformance D).
- `abort()`:
  - flips `aborted = true` (preempts the per-iteration loop on the next
    yielded transport event);
  - calls `aborter.abort()` (signals the transport to tear down its
    subprocess / HTTP request — the existing `streamAnthropicResponse`
    honors `signal` and kills the spawned `claude` subprocess);
  - awaits the in-flight stream consumption to drain so the promise
    resolves only when the adapter is actually stopped.
- Idempotent (F): two `abort()`s are a no-op.
- Safe after completion (G): `aborter.abort()` on an already-fired
  controller is a no-op.

### Real-CLI smoke tests

`test/canonical-loop-09-anthropic-smoke.test.ts` is gated behind
`LAX_RUN_ANTHROPIC_SMOKE=1`. By default it skips — the standard test
suite never makes live external API calls. Smoke tests cover end-to-end
submit, real cancel mid-stream (subprocess actually killed), and crash
recovery with `provider_state` round-trip.

### Wire-up

`setDefaultAdapterForLane("interactive", () => createAnthropicAdapter())`
wires the adapter as the lane=interactive default when the host app
chooses to. Issue 09 ships the adapter and the wiring helper; the
actual cutover (flag-flip default) lands separately.

## Issue 11 — v1.0 hardening cap

The "everything together" cap that closes v1.0. Every prior issue ships
one slice; Issue 11 proves the slices compose under load and stress.

### Permanent invariants (asserted across the suite)

| # | Invariant | Where enforced |
|---|---|---|
| I1 | `op.canonical.state` equals the `to` of the latest `state_changed` event | `assertCanonicalInvariants` in `test/canonical-loop-11-invariants.test.ts` |
| I2 | `op.canonical.currentTurnIdx` equals MAX(`op_turns.turnIdx`) when any turn committed | same |
| I3 | Per-op `op_events.seq` monotonic 0..N with no gaps and no cross-op leak | same + `concurrency.test.ts` |
| I4 | Per-op `op_turns.turn_idx` monotonic with no gaps | same |
| I5 | Exactly one terminal `state_changed` event per op (`succeeded` / `failed` / `cancelled`) | same |
| I6 | Terminal ops have `leaseOwner=null` and `leaseExpiresAt=null` | same |

`assertCanonicalInvariants(opId)` is exported from the Issue 11
invariants test as a reusable helper — any test that drives an op to
terminal can call it to enforce the full invariant set in one shot.

### Boundary audits

`test/canonical-loop-11-boundary-audit.test.ts` runs static-import
audits on the canonical-loop source tree:

- No file under `src/canonical-loop/` (loop modules) imports
  `child_process` or `node:child_process`. Subprocess primitives live
  behind the adapter contract — the loop never spawns processes.
- Adapter source files (`src/canonical-loop/adapters/*.ts`) import
  nothing on `FORBIDDEN_ADAPTER_IMPORTS` (`workers/op-store`,
  `workers/event-log`, `workers/pool`, `canonical-loop/store`,
  `child_process`).
- Exception: `adapters/anthropic-transport.ts` is the bounded
  transport-boundary file. The audit allow-lists this exact path
  and audits everything else.
- The `FORBIDDEN_ADAPTER_IMPORTS` set itself is locked — any change
  to the list fails the audit.

### Concurrency isolation (PRD acceptance #10)

`test/canonical-loop-11-concurrency.test.ts` exercises the
"5 concurrent ops mixed across lanes" scenario the PRD specifies.
Lane caps are respected (interactive=1, build=2, ide=1, background=1),
per-op seq stays monotonic, no cross-op contamination of events,
messages, provider_state, or workerIds.

### "No op escapes canonical" (PRD §20)

`test/canonical-loop-11-no-op-escapes-canonical.test.ts` is the
post-cutover invariant the PRD locks in for the lifetime of the
project — under flag ON, every terminal scenario (succeeded / failed /
cancelled / pre-lease cancel) leaves canonical artifacts and **zero**
legacy `events.jsonl`.

### Hardening (cross-slice composition)

`test/canonical-loop-11-hardening.test.ts` exercises edge interleavings
the per-issue suites don't cover on their own:

- Stale worker waking up after the op terminated cannot mutate state
  (state-machine throws `IllegalTransitionError`; `commitTurn`
  idempotent guard returns `inserted: false`).
- A delayed adapter result arriving after cancel does not commit a
  turn.
- A delayed adapter result arriving after lease recovery does not
  produce a duplicate `op_turns` row (Issue 08 PK guard).
- `cancel-during-pause` and `cancel-during-redirect` are deterministic:
  cancel always wins (PRD §13).
- Pause idempotency holds across racing actors — one
  `pause_requested` event regardless of how many `opPause` calls land.
- Pause+resume+redirect chain leaves exactly one `redirect_applied`
  event on the resumed turn.
- A burst of concurrent pause+cancel calls produces exactly one of
  each control event in the durable log.

### Rollback

[docs/runbooks/canonical-loop-rollback.md](../../docs/runbooks/canonical-loop-rollback.md)
documents the flip-the-flag rollback procedure: per-lane env var,
in-flight ops drain on canonical (their flag value is captured at
submit and immutable), new ops route to legacy. No code change, no
schema migration.

### v1.0 ship readiness

PRD §22 Definition of Done — current state of the canonical loop:

| Item | Status |
|---|---|
| canonical-loop modules ≤ 400 LOC each | green |
| Anthropic adapter implements locked contract | green (Issue 09) |
| Worker pool with op-level leases + heartbeats | green (Issues 03, 08) |
| Single queue with lane scheduling | green (Issue 03) |
| `op_pause` / `op_cancel` / `op_redirect` / `op_resume` / `op_events_since` live | green (Issues 04–07) |
| Feature flag routing inside `op_submit_async` | green (Issues 01, 10) |
| Schema additions migrated | green (Issue 01) |
| All 11 v1 acceptance tests pass under fake adapter | green (Issues 01–11) |
| All 9 conformance items pass for Anthropic | green (Issue 09) |
| Real Anthropic CLI smoke tests | gated, opt-in via `LAX_RUN_ANTHROPIC_SMOKE=1` |
| Permanent invariant tests | green (Issue 11) |
| Old-path compatibility test #11 | green (Issue 10) |
| No diff against PRD §19 untouchables | green |
| Public API signatures unchanged | green (Issue 10 compat fixtures verify) |
| Feature flag defaults OFF | green |
| Rollback procedure documented | green (this issue) |
| Adapter sandbox audit clean | green (Issue 11 boundary audit) |
| Loop has no `child_process` imports | green (Issue 11 boundary audit) |
| PRD glossary terms used consistently in code identifiers | green |
| No code, comment, or commit references competitor products | green |

The remaining DoD items — real-staging exercises (one real worker
death, one real client reconnect against the live Anthropic adapter)
— are operational gates, not code work. They block "tag v1.0; canary
on" but not "Issue 11 ships".
