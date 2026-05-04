# Issue 05 — Pause + resume at turn boundary

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 03

---

## Goal

Implement soft pause and resume per the PRD control plane: `op_pause` sets `pause_requested_at`, the loop applies it at the next turn boundary by transitioning `running` → `paused` and releasing the lease; `op_resume` transitions `paused` → `queued` and a worker re-leases, replaying from the last committed checkpoint. Implements PRD acceptance tests #3 and #4.

## Why it matters

Pause/resume is a primary user-visible control and a load-bearing test of the turn-boundary semantics. It also exercises the lease-release path that issue 08 will exercise from a different angle (crash recovery).

## Scope

- Public APIs `op_pause(op_id, actor)` and `op_resume(op_id, actor)`:
  - `op_pause` sets `ops.pause_requested_at`, emits `pause_requested` event, publishes signal to bus.
  - `op_resume` transitions `paused` → `queued` (only valid from `paused`), emits `resume_requested` event.
- Worker intake:
  - Fast path: subscribe to bus signals for leased ops.
  - Slow path: re-read signal columns at every turn boundary.
- Loop application semantics:
  - At post-turn boundary, if `pause_requested_at` non-null and no `cancel_requested_at`: transition `running` → `paused`, release lease (clear `lease_owner`, set `lease_expires_at` to past), clear `pause_requested_at`, emit `state_changed`. Worker exits the op_loop cleanly.
  - On resume, scheduler re-leases; worker reads last `op_turns` row, hands `provider_state` to adapter, drives next turn.

## Non-goals

- Cancel (issue 07).
- Redirect (issue 06).
- Hard pause / mid-stream interruption (PRD locks pause as soft only).
- Multi-pause stacking semantics (idempotent — second pause request on already-paused op is a no-op).

## Likely files / modules

- `src/canonical-loop/control-api.ts` — adds `op_pause` and `op_resume`.
- `src/canonical-loop/turn-loop.ts` — extends post-turn boundary with signal check.
- `src/canonical-loop/state-machine.ts` — adds `paused` transitions.
- `src/canonical-loop/bus.ts` — signal channel naming.
- `tests/canonical-loop/pause-resume.test.ts`.

## Dependencies / blockers

- Issue 03 (loop happy path).

## Acceptance criteria

- PRD acceptance test #3 (pause at turn boundary) passes:
  - Pause requested mid-turn.
  - Current turn finishes cleanly and commits.
  - State transitions `running` → `paused`.
  - Lease released.
  - `pause_requested_at` cleared.
  - No further turns run.
- PRD acceptance test #4 (resume from paused) passes:
  - `op_resume` transitions `paused` → `queued` → `running`.
  - Worker re-leases.
  - Adapter receives prior `provider_state` envelope.
  - Op completes normally from the next turn.
- Idempotent pause: calling `op_pause` twice on a running op only triggers one `pause_requested` event chain and one `paused` transition.
- Resume on a non-paused op returns a documented error response.

## Tests required

- PRD test #3.
- PRD test #4.
- Idempotency: double `op_pause` while running yields one transition.
- Pause then redirect arrives before pause applies → pause still wins (cancel-only overrides, redirect does not).
- Pause-resume-pause-resume cycle.
- Audit: `op_events` shows `pause_requested` then `state_changed (running→paused)` then later `resume_requested` then `state_changed (paused→queued)` and `state_changed (queued→running)` in correct seq order.

## Definition of done

- [ ] `op_pause` and `op_resume` live; idempotent and documented.
- [ ] PRD tests #3 and #4 green.
- [ ] State transitions for `paused` and back-to-`queued` enforced (single writer = canonical-loop).
- [ ] Audit trail in `op_events` correct.
- [ ] No untouchable modified.
- [ ] Modules within 400 LOC.
