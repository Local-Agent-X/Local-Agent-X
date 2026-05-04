# Issue 08 — Lease heartbeat + crash recovery

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 03

---

## Goal

Implement lease heartbeating and crash recovery: a worker death mid-turn results in lease expiry, the op transitions `running` → `queued`, another worker re-leases, replays from the last committed `op_turns` row, and the op completes. Also covers idempotent turn replay (PK conflict on `op_turns` is handled gracefully). Implements PRD acceptance tests #7 and #8.

## Why it matters

Crash recovery is the headline reliability win that fragmented paths cannot match today. Without this, every other v1 issue is moot — the loop has not earned its name. This is also the test that validates the `provider_state` round-trip is real, since recovery hinges on the adapter's ability to resume from the opaque blob.

## Scope

- Lease lifecycle:
  - Worker acquires lease via atomic DB update with `WHERE state='queued' AND (lease_owner IS NULL OR lease_expires_at < now())`.
  - On acquire: set `lease_owner=worker_id`, `lease_expires_at = now() + 30s` (configurable).
  - Worker heartbeat every 10 seconds (configurable): extend `lease_expires_at` by lease duration.
  - On heartbeat miss / worker death: another worker can acquire after `lease_expires_at`.
- Re-lease and resume:
  - Re-leasing worker reads last `op_turns` row.
  - Hands `provider_state` envelope to adapter.
  - Drives turn `last.turn_idx + 1`.
  - Pending `redirect_instruction` applied on first resumed turn if present.
- State transition on lease expiry:
  - Detected by next-leasing worker or by a janitor query — TBD during impl, document chosen approach.
  - Loop transitions `running` → `queued` (only one writer; using DB row ownership at time of transition).
  - Emits `lease_lost` event with `reason: 'expired'`.
  - On re-lease, emits `lease_acquired` with new `worker_id`.
- Idempotent turn write:
  - PK `(op_id, turn_idx)` enforced.
  - If a re-leased worker tries to commit a turn that already exists: catch PK conflict, treat as "already committed," advance to next turn.

## Non-goals

- Multi-worker stress / concurrency tuning beyond what's needed for test #7.
- Lease backoff / fairness algorithms.
- Detecting "stuck" ops that are running but never heartbeating their work — that's a follow-up.
- Modifying tool-executor to handle re-execution of partial tool runs.

## Likely files / modules

- `src/canonical-loop/lease.ts` — atomic acquire + heartbeat helpers.
- `src/canonical-loop/scheduler.ts` — extended to detect expired leases.
- `src/canonical-loop/worker.ts` — heartbeat loop + abort-on-shutdown semantics.
- `src/canonical-loop/turn-loop.ts` — idempotent commit handling.
- `tests/canonical-loop/crash-recovery.test.ts` — uses harness clock + crash sim.

## Dependencies / blockers

- Issue 03 (loop happy path).

## Acceptance criteria

- PRD acceptance test #7 (crash recovery via lease expiry) passes:
  - Submit op, worker starts a turn.
  - Force-kill worker (harness crash sim).
  - Advance fake clock past `lease_expires_at`.
  - Second worker acquires the lease.
  - Adapter receives the prior `provider_state` envelope from the last `op_turns` row.
  - Op completes `succeeded`.
  - `op_events` shows `lease_lost` and `lease_acquired` with different `worker_id`s in order.
- PRD acceptance test #8 (idempotent turn replay) passes:
  - Synthetic case: worker commits `op_turns` row but pretends transaction ack lost.
  - Re-leased worker attempts to commit same turn.
  - PK conflict caught; loop treats as "already committed."
  - State remains correct; `current_turn_idx` advances normally.
- Lease duration and heartbeat are configurable (default 30s / 10s as PRD §21).
- A worker shutting down cleanly releases its lease (graceful unwind).

## Tests required

- PRD test #7.
- PRD test #8.
- Heartbeat extends lease as expected (under fake clock).
- Multiple lease expirations in a row (worker A dies → B leases → B dies → C leases) all succeed.
- Worker shutdown during a turn boundary releases lease cleanly.
- Boundary check: lease columns are only written via `lease.ts` helpers; no other module mutates `lease_owner` / `lease_expires_at`.

## Definition of done

- [ ] Heartbeat loop runs every 10s by default, configurable.
- [ ] Lease duration 30s by default, configurable.
- [ ] PRD tests #7 and #8 green under fake adapter + crash harness.
- [ ] No untouchable modified.
- [ ] Modules within 400 LOC.
