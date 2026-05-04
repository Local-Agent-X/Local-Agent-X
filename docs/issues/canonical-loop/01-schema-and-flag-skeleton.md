# Issue 01 — Schema additions + feature flag compatibility skeleton

**Phase:** Foundation
**Blocks:** All subsequent canonical-loop issues
**Blocked by:** None

---

## Goal

Land the additive schema changes (`op_turns`, `op_messages`, `op_events`, new columns on `ops`) and wire the `lax.canonical_loop.{lane}` feature flag into `op_submit_async`. Flag OFF must behave exactly like main today; flag ON routes to a stub canonical-loop entry point that records the routing decision but otherwise no-ops (or fails closed) until issue 03 lands the real loop.

## Why it matters

The PRD requires additive-only schema and parallel-run safety. Every later issue depends on these tables existing and the flag mechanism being live. Shipping this first proves we can land schema + flag with zero regression to legacy `op_submit_async`.

## Scope

- Add tables `op_turns`, `op_messages`, `op_events` per [PRD §9](../../canonical-loop-prd.md#9-data-model--schema-additions).
- Add additive columns to `ops`: `lane`, `lease_owner`, `lease_expires_at`, `pause_requested_at`, `cancel_requested_at`, `redirect_instruction`, `redirect_received_at`, `current_turn_idx`, `current_checkpoint_id`, `canonical_flag_value`, `session_id`.
- Add migration files under the project's existing migration path.
- Add a feature flag reader (config or env-driven for v1) keyed by lane.
- Add a routing branch inside `op_submit_async` that:
  - Reads the flag.
  - Captures the flag value on the new `ops.canonical_flag_value` column.
  - If OFF → calls existing legacy execution path unchanged.
  - If ON → calls a `canonical_loop_entry(op)` stub that for now writes a single `state_changed` event and returns (full implementation lands in issue 03).
- Document the flag, default values, and capture semantics in PRD §17 if any drift.

## Non-goals

- Implementing turn execution, checkpoints, control plane, leases, or events beyond a single skeleton write.
- Touching legacy execution code paths beyond inserting the flag-routing branch.
- Performance tuning, indexing beyond what PRD §9 specifies.
- UI changes.

## Likely files / modules

- `migrations/` (or project equivalent) — new migration adding tables + columns.
- `src/canonical-loop/index.ts` — module entry, exports `canonical_loop_entry()` stub.
- `src/canonical-loop/types.ts` — DB row types for `ops`, `op_turns`, `op_messages`, `op_events`.
- `src/canonical-loop/feature-flag.ts` — flag reader.
- `op_submit_async` source file (locate via grep) — additive routing branch only.
- `src/canonical-loop/schema.ts` (optional) — typed schema constants for column names.

## Dependencies / blockers

- None. This is the foundation.

## Acceptance criteria

- Migrations apply cleanly on a dev DB and on a copy of staging.
- All four new tables exist with PKs and indexes as specified in PRD §9.
- All additive columns on `ops` are nullable (or have safe defaults) and do not break existing inserts/queries.
- With flag OFF: legacy `op_submit_async` behavior is byte-identical to pre-change main. Snapshot tests against recorded fixtures pass.
- With flag ON for `interactive` lane: `op_submit_async` returns the same response shape, `ops.canonical_flag_value=true` is recorded, exactly one `state_changed` event row is written to `op_events` for that op (`{from: null, to: 'queued'}`), and no rows are written to legacy execution tables.
- Existing tests on main still pass.
- No diff in [untouchables](../../canonical-loop-prd.md#19-untouchables--constraints).

## Tests required

- Migration up/down test.
- Snapshot fixture test for `op_submit_async` with flag OFF (re-uses fixtures recorded at this commit).
- Smoke test: flag ON submission writes `op_events` skeleton row, `ops.canonical_flag_value`, and nothing else.
- Sanity: legacy queries on `ops` still work with the new columns present.

## Definition of done

- [ ] All migrations land and apply on dev + a staging clone.
- [ ] Flag reader implemented and documented.
- [ ] `op_submit_async` routing branch live, default OFF.
- [ ] Snapshot fixtures recorded and committed.
- [ ] Smoke test for flag ON skeleton write passes.
- [ ] No public API signature changes.
- [ ] No untouchable file modified.
- [ ] PR ≤ 400 LOC per new module file.
