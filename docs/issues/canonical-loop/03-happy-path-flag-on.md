# Issue 03 — Minimal canonical-loop happy path through `op_submit_async` (flag ON)

**Phase:** Vertical slice
**Blocks:** 04, 05, 06, 07, 08
**Blocked by:** 01, 02

---

## Goal

End-to-end happy path: with flag ON for `interactive`, `op_submit_async` routes through canonical-loop, a single in-process worker leases the op, drives the turn_loop using a scripted `FakeAdapter`, commits the checkpoint, transitions the op to `succeeded`, and emits the canonical events in correct order. Implements PRD acceptance test #1.

## Why it matters

This is the first vertical slice that proves the loop end-to-end. After this, we have a real backbone to attach pause/cancel/redirect/recovery onto. Most subsequent issues are additive on top of this skeleton.

## Scope

- Implement minimum subset of canonical-loop:
  - State machine writer for `queued` → `running` → `succeeded` transitions.
  - Single in-process worker that leases ops by atomic DB update.
  - `turn_loop` driver: assemble prompt → call `adapter.runTurn` → handle `adapter_report` items (`message_finalized`, `tool_call_requested`, `stream_chunk`, `error`) → commit checkpoint at post-turn boundary.
  - Tool call dispatch via `tool-executor.ts` (call existing API; do not modify).
  - Atomic post-turn write: insert `op_turns` row + `op_messages` rows + update `ops.state` (if terminal) + update denormalized `current_turn_idx` + `current_checkpoint_id` + insert `state_changed` and `turn_committed` rows in `op_events`.
  - Stream chunk forwarding to bus channel `op_stream:{op_id}`.
  - Lane scheduling for `interactive` only, cap = 1.
- Wire `canonical_loop_entry()` (from issue 01) to actually drive the op.
- All event types emitted in this happy path: `lease_acquired`, `state_changed` (queued→running), `turn_started`, `tool_started`/`tool_finished` if any, `message_appended`, `turn_committed`, `state_changed` (running→succeeded), `lease_lost` (clean release).

## Non-goals

- Pause, cancel, redirect, resume (issues 05, 06, 07).
- Lease expiry / crash recovery (issue 08).
- Reconnect replay logic (issue 04).
- Real Anthropic CLI (issue 09).
- Multi-worker concurrency (cap stays at 1; isolation tested in issue 11).
- Build / IDE lanes.

## Likely files / modules

- `src/canonical-loop/state-machine.ts` — transition function + sole-writer enforcement.
- `src/canonical-loop/turn-loop.ts` — inner per-turn driver.
- `src/canonical-loop/checkpoint.ts` — atomic post-turn commit.
- `src/canonical-loop/scheduler.ts` — single-lane FIFO lease.
- `src/canonical-loop/worker.ts` — in-process async worker function.
- `src/canonical-loop/event-emitter.ts` — DB write + bus publish.
- `src/canonical-loop/bus.ts` — pub/sub abstraction (existing app pub/sub if present, else `EventEmitter`).
- `src/canonical-loop/index.ts` — exports + `canonical_loop_entry()` real impl.
- `src/canonical-loop/types.ts` — extended types for `TurnInput`, `AdapterReport`, `TurnResult`.

## Dependencies / blockers

- Issue 01 (schema + flag).
- Issue 02 (fake adapter + harness).

## Acceptance criteria

- PRD acceptance test #1 (happy path) passes with `FakeAdapter` scripted to a single text-only turn.
- Multi-turn happy path (e.g., 3 turns with tool calls in between) also reaches `succeeded` with monotonic `seq` 0..N, no gaps, `turn_idx` 0..M, no gaps.
- `ops.current_turn_idx` matches `MAX(op_turns.turn_idx)` after completion.
- All atomic-write rules from PRD §11 hold under test.
- Tool calls dispatched through `tool-executor.ts` only (no direct execution in canonical-loop).
- Stream chunks flow through `op_stream:{op_id}` bus channel and are not persisted to `op_events`.
- Loop has no `child_process` import; adapter only emits `adapter_report` items.

## Tests required

- PRD acceptance test #1 (happy path, single turn).
- Happy path multi-turn variant.
- Happy path with tool call (fake tool registered through `tool-executor.ts` test fixtures).
- Boundary-violation test: assert canonical-loop module has no `child_process` import; assert `FakeAdapter` has no DB handle reference.
- Invariant check after every test: `ops.state == latest state_changed.to`.

## Definition of done

- [ ] PRD test #1 + multi-turn variant + tool-call variant all green.
- [ ] No new public API signatures broken.
- [ ] All canonical-loop modules ≤ 400 LOC.
- [ ] No untouchable modified.
- [ ] Loop / adapter sandbox boundary verified by test (audit imports).
- [ ] Documented module map in `src/canonical-loop/README.md`.
