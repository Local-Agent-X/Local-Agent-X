# Issue 04 — Event log + `op_events_since` reconnect replay

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 03

---

## Goal

Land the `op_events_since(op_id, seq)` public API and prove durable reconnect replay: a client that disconnects mid-op can reconnect, fetch all events with `seq > N`, and re-attach to the bus without missing any canonical event. Implements PRD acceptance test #9.

## Why it matters

Reconnect replay is one of the load-bearing reliability claims of canonical-loop and is exactly what existing fragmented paths cannot do. The PRD requires this to ship in v1, not be deferred to UI.

## Scope

- Public API `op_events_since(op_id, seq)`:
  - Returns ordered events from `op_events` `WHERE op_id=? AND seq > ? ORDER BY seq`.
  - Streamed or paginated as appropriate; behavior documented.
  - Accepts `seq=-1` (or equivalent sentinel) to mean "from the start."
- Bus subscription protocol for `op_stream:{op_id}` and the canonical event channel:
  - Subscribers can attach at any time.
  - Reconnect protocol documented: client tracks `last_seq`, on reconnect calls `op_events_since(op_id, last_seq)`, applies in order, then re-attaches to bus.
- Confirm event durability rules from PRD §6:
  - `state_changed`, `turn_committed`, `redirect_applied` written same transaction as state.
  - All other events durable but best-effort timing.
- Error handling: API surface for unknown `op_id`, invalid `seq`.

## Non-goals

- UI integration (separate issue, not in v1).
- Adding new event types beyond the locked v1 set.
- Persisting stream chunks (explicit non-goal per PRD).
- Cross-op event subscriptions.

## Likely files / modules

- `src/canonical-loop/control-api.ts` — adds `op_events_since` (and any other missing public APIs landed here).
- `src/canonical-loop/event-emitter.ts` — extend to publish on bus after DB write.
- `src/canonical-loop/bus.ts` — channel naming + subscription helpers.
- API surface file (locate via grep) — register `op_events_since` endpoint.
- `tests/canonical-loop/reconnect.test.ts` — replay scenarios.

## Dependencies / blockers

- Issue 03 (canonical-loop happy path emits the event log this depends on).

## Acceptance criteria

- PRD acceptance test #9 (reconnect replay) passes:
  - Client subscribes, captures events up to `seq=N`.
  - Disconnect simulated.
  - Op continues to completion; canonical events accumulate in DB.
  - Client reconnects via `op_events_since(op_id, N)` and receives all `seq=N+1..M` in order.
  - Client re-attaches to bus and receives any new events without duplicates or gaps.
- API returns events in `seq` order, no duplicates, no gaps.
- API call with `seq` greater than current `MAX(seq)` returns empty list (not an error).
- API call for nonexistent `op_id` returns a documented error response.
- Per-op `seq` continues to be monotonic and gap-free under load (assert against batch of concurrent ops).

## Tests required

- PRD test #9 (reconnect replay).
- Edge: reconnect at `seq=0` returns full event history.
- Edge: reconnect at `seq=MAX` returns empty.
- Edge: rapid emission then reconnect — all events captured in order.
- Concurrent ops: each op's seq remains independent and gap-free.

## Definition of done

- [ ] `op_events_since` API live, documented in PRD §13 or in the module README.
- [ ] PRD test #9 green.
- [ ] Reconnect protocol documented (single-page reference, can live in `src/canonical-loop/README.md`).
- [ ] No tokens persisted to `op_events`.
- [ ] No untouchable modified.
- [ ] Module sizes within 400 LOC.
