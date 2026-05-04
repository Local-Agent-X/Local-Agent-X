# Issue 10 — Old-path compatibility fixtures (flag OFF)

**Phase:** Vertical slice
**Blocks:** 11
**Blocked by:** 01

---

## Goal

Record snapshot fixtures of the legacy `op_submit_async` path's externally-observable behavior on main, then assert that with the canonical-loop feature flag OFF those fixtures still match exactly. This is the parallel-run safety net: it proves we have not silently regressed the live hot path while landing canonical-loop. Implements PRD acceptance test #11.

## Why it matters

Parallel-run is only safe if we can detect drift in the legacy path. Without recorded fixtures, "flag OFF behaves the same" is hand-waved. This issue is what guarantees rollback works for the entire v1 series.

## Scope

- Identify the externally-observable surfaces of legacy `op_submit_async`:
  - Return shape (fields, types, null vs. omit).
  - Side effects in the existing DB tables (legacy execution tables / status rows / stream channels).
  - Timing characteristics that callers depend on (synchronous vs. async behavior, error shapes).
- Record golden-master fixtures for a representative set of submission scenarios (text-only, tool-using, error path, etc.).
- Add fixture-replay tests that, with flag OFF:
  - Assert response shape matches recorded fixture byte-for-byte.
  - Assert side-effect tables receive identical writes.
  - Assert no rows are written to `op_turns` / `op_messages` / `op_events`.
- Add fixture-replay tests that, with flag ON:
  - Assert response shape matches the same recorded fixture byte-for-byte.
  - Assert no writes to legacy execution tables.
  - Assert canonical tables receive expected writes.
- Document fixture refresh process: when legacy path intentionally changes, fixtures are regenerated on a separate explicit commit.

## Non-goals

- Modifying legacy execution path.
- Changing public API shape (this issue exists to prevent that).
- Testing UI behavior.

## Likely files / modules

- `tests/canonical-loop/fixtures/legacy/*.json` — recorded fixtures.
- `tests/canonical-loop/old-path-compat.test.ts` — fixture replay assertions.
- `tests/canonical-loop/fixture-recorder.ts` — utility to capture fresh fixtures from a controlled run.

## Dependencies / blockers

- Issue 01 (flag plumbing in `op_submit_async` — needed to actually toggle).
- Ideally landed before issue 03 so the foundation has a safety net.

## Acceptance criteria

- PRD acceptance test #11 passes:
  - Flag OFF: `op_submit_async` byte-identical to recorded fixtures; no canonical-table writes.
  - Flag ON: `op_submit_async` byte-identical response; no legacy-execution-table writes; canonical tables populated.
- Fixture set covers at least: simple text request, tool-using request, error case, large-input case.
- Fixtures are committed and human-readable.
- Fixture refresh procedure documented in `tests/canonical-loop/fixtures/README.md`.

## Tests required

- PRD test #11 (compatibility test).
- Fixture-mismatch failure produces a clear diff.
- Fixture refresh rerun produces stable output (deterministic capture).

## Definition of done

- [ ] Fixtures committed.
- [ ] Compat tests green for flag OFF and flag ON.
- [ ] Fixture refresh process documented.
- [ ] No legacy execution code modified by this issue.
- [ ] No untouchable modified.
