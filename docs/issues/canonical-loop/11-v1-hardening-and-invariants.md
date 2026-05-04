# Issue 11 — v1.0 hardening, concurrency isolation, permanent invariants

**Phase:** Cap (ship gate for v1.0)
**Blocks:** v1.0 ship + post-v1.0 follow-ups
**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10

---

## Goal

Close out v1.0 by landing the remaining acceptance test (#10 concurrent ops isolation), the permanent invariant test (`ops.state` matches latest `state_changed.to`), the boundary audit tests (loop has no `child_process`, adapters have no DB handles), and the documentation/operational artifacts that complete the PRD §22 Definition of Done.

## Why it matters

Each prior issue lands one slice of canonical-loop. This issue is the "everything-together" cap: prove the slices compose under load, that invariants hold across the matrix of scenarios, and that operationally we can ship. Without this, v1.0 is a pile of green tests that haven't been seen running together.

## Scope

- PRD acceptance test #10 (concurrent ops isolation):
  - Submit 5 ops concurrently with the fake adapter.
  - Each emits ~20 events.
  - Per-op `seq` monotonic 0..K_i with no gaps; no event has wrong `op_id`.
  - All five reach `succeeded` independently.
- Permanent invariant tests (run after every test in the suite):
  - `ops.state == latest state_changed.to` for every op touched.
  - `ops.current_turn_idx == MAX(op_turns.turn_idx)` for every op with at least one committed turn.
  - `op_events.seq` per op is monotonic with no gaps.
  - `op_turns.turn_idx` per op is monotonic with no gaps.
- Boundary audit tests:
  - Static import audit: no canonical-loop module imports `child_process`, `node:child_process`, or equivalent.
  - Static import audit: adapters have no DB client imports, no `op_events` writer imports, no worker-pool imports.
  - Runtime audit: adapter sandbox enforces by interface (no escape hatches).
- "No op escapes canonical" test (gated by flag ON):
  - Every `op_submit_async` call with flag ON results in rows in `ops`, at least one `op_turns` row (unless terminal-before-first-turn explicitly recorded), and `op_events` rows with monotonic seq.
- Operational artifacts:
  - Rollback procedure documented (flip flag OFF; in-flight ops complete normally).
  - Real-staging exercise: at least one real worker death and one real client reconnect proven in staging, recorded in DoD checklist.
  - PRD §22 DoD checklist updated to reflect v1.0 ship readiness.

## Non-goals

- Multi-worker concurrency stress (still cap=1 in `interactive`; multi-worker tuning is post-v1).
- Load / performance testing.
- New event types.
- Codex / build / IDE work.
- UI E2E.

## Likely files / modules

- `tests/canonical-loop/concurrency.test.ts` — PRD test #10.
- `tests/canonical-loop/invariants.test.ts` — permanent invariants.
- `tests/canonical-loop/boundary-audit.test.ts` — import audit + sandbox checks.
- `tests/canonical-loop/no-op-escapes-canonical.test.ts` — flag-ON cutover invariant.
- `docs/runbooks/canonical-loop-rollback.md` — rollback procedure.
- `docs/canonical-loop-prd.md` — DoD checklist updates if any drift.

## Dependencies / blockers

- All prior v1 issues (01–10).

## Acceptance criteria

- PRD acceptance test #10 green.
- All permanent invariants green across every existing test.
- Boundary audits green: no banned imports.
- Rollback runbook exists, reviewed.
- Real staging exercise recorded: one real worker death and one real client reconnect proven against the Anthropic adapter.
- PRD §22 DoD checklist all items checked.

## Tests required

- PRD test #10.
- Invariant tests (run as a global afterEach across the suite).
- Boundary audit tests.
- "No op escapes canonical" test.

## Definition of done

- [ ] All 11 v1 acceptance tests green together (full suite run, not just per-issue).
- [ ] All 9 conformance items green for Anthropic adapter.
- [ ] Permanent invariants enforced across the suite.
- [ ] Boundary audits green.
- [ ] Real CLI smoke + real staging exercise recorded.
- [ ] Rollback runbook landed.
- [ ] PRD §22 DoD checklist fully checked.
- [ ] No untouchable modified.
- [ ] Tag v1.0; ready for canary opt-in.
