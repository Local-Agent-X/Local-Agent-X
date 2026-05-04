# Issue 07 — Cancel mid-stream via `adapter.abort()`

**Phase:** Vertical slice
**Blocks:** 09, 11
**Blocked by:** 03

---

## Goal

Implement hard cancel: `op_cancel` sets `cancel_requested_at`, the worker calls `adapter.abort()` immediately (not at turn boundary), state transitions `running` → `cancelling` → `cancelled` once the adapter has actually drained, the partial uncommitted turn is discarded, and the prior committed checkpoint remains the last good state. Implements PRD acceptance test #2.

## Why it matters

Cancel is the only signal that overrides turn-boundary semantics. It is the load-bearing test of the `adapter.abort()` contract — the existence of which is the entire reason adapters can be swapped. Without working mid-stream cancel, the canonical-loop adds no real reliability over the legacy paths.

## Scope

- Public API `op_cancel(op_id, actor)`:
  - Writes `ops.cancel_requested_at`.
  - Emits `cancel_requested` event.
  - Publishes fast-path signal on bus.
- Worker intake:
  - On bus signal during `running` state: immediately call `adapter.abort()`.
  - On signal at turn boundary: skip turn-boundary path, go straight to abort.
- Loop application:
  - Transition `running` → `cancelling` immediately.
  - Await `adapter.abort()` resolution.
  - On resolution: discard partial uncommitted turn, transition `cancelling` → `cancelled`, release lease, emit terminal `state_changed`.
- Precedence:
  - Cancel wins over pause and redirect.
  - If both pause and cancel are pending: cancel applied immediately, op terminates `cancelled` (not `paused`).

## Non-goals

- Soft cancel / "cancel at turn boundary" variant.
- Cancel-with-grace-period.
- Modifying `tool-executor.ts` to abort in-flight tool calls — issue is scoped to adapter-level abort. (If a tool is mid-flight inside `tool-executor`, the loop awaits its completion; if this proves problematic, file a follow-up issue. Do not change tool-executor here.)
- Subprocess hardening beyond what the Anthropic adapter already does.

## Likely files / modules

- `src/canonical-loop/control-api.ts` — adds `op_cancel`.
- `src/canonical-loop/worker.ts` — abort intake + state transition orchestration.
- `src/canonical-loop/state-machine.ts` — `cancelling` / `cancelled` transitions.
- `src/canonical-loop/turn-loop.ts` — abort-aware unwind.
- `tests/canonical-loop/cancel.test.ts`.

## Dependencies / blockers

- Issue 03 (loop happy path).

## Acceptance criteria

- PRD acceptance test #2 (cancel mid-stream) passes:
  - Submit op, adapter starts streaming.
  - `op_cancel` called.
  - `adapter.abort()` invoked within 1 second.
  - State transitions `running` → `cancelling` → `cancelled`.
  - Subprocess is dead (no leaked PID — verified via fake adapter's hooks; real Anthropic verified in issue 09).
  - Partial uncommitted turn is discarded; latest committed `op_turns` row is unchanged.
  - Lease released.
- Cancel after terminal state: documented behavior (no-op or documented error).
- Cancel during `paused`: transitions `paused` → `cancelling` → `cancelled` (without re-leasing).
- Cancel during `cancelling`: idempotent.

## Tests required

- PRD test #2.
- Cancel during `awaiting_model` phase tag.
- Cancel during `streaming` phase tag.
- Cancel during `executing_tools` phase tag (best-effort: adapter aborts; tool-executor allowed to complete current tool).
- Cancel on already-paused op.
- Cancel on already-terminal op (no-op or documented error).
- Audit: events sequence includes `cancel_requested`, `state_changed (running→cancelling)`, `state_changed (cancelling→cancelled)` in order.
- Boundary check: `adapter.abort()` is called from canonical-loop, not from public API directly.

## Definition of done

- [ ] `op_cancel` live; idempotent.
- [ ] PRD test #2 green.
- [ ] Cancel from `paused` → `cancelled` works.
- [ ] No untouchable modified (tool-executor especially).
- [ ] Modules within 400 LOC.
