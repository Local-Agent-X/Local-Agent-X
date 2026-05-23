# Canonical-loop rollback runbook

**Audience:** on-call / shipper.
**Scope:** the LAX canonical op loop (sole execution path since the worker-pool retirement landed 2026-05-15).
**Source of truth:** [PRD §17 / §22](../canonical-loop-prd.md).

The canonical loop is the **only** execution path for ops. There is no
legacy fork path to roll back to. **The `LAX_CANONICAL_LOOP_*` flags no
longer route anything** — they exist only so legacy callers and soak
scripts that still read them keep compiling. Setting any of them does
not change runtime behavior.

---

## TL;DR

**Rollback now means `git revert` the commit that deleted the worker
pool, then redeploy.** It is not a flag flip.

1. Identify the offending commit (Phase 2 deletion or a regression that
   landed on top of canonical-loop).
2. `git revert <sha>` on a branch.
3. Build, smoke, deploy.
4. Capture the incident.

There is no in-process knob that can restore the fork lifecycle without
a code release.

---

## When to roll back

Roll back if any of these are observed:

- A canonical op gets stuck in `running` past its lease window AND
  `recoverStaleOp` doesn't restore it.
- `op_events` seq gaps appear for any op (per-op monotonic invariant
  broken — Issue 11 invariants test would catch this).
- `op_submit_async` response shape regresses (Issue 10 compat test
  would catch this).
- Adapter conformance fails on a real-CLI smoke (Issue 09 gated suite).
- A user-visible regression: terminal events missing, sidebar cards
  stuck, cancel button no-ops, etc.

If symptoms are **adapter-specific** (e.g., the Anthropic adapter is
crashing but the Codex adapter is fine), prefer narrowing to the
adapter rather than reverting the whole worker-pool retirement.

---

## Rollback procedure

### 1. Pick the revert target

Most likely candidates:

- The Phase 2 deletion commit (`refactor(ops): delete worker-pool fork
  lifecycle`) — restores fork-based execution outright.
- A specific canonical-loop change that landed on top — narrower revert.

`git log --oneline -- src/canonical-loop/ src/workers/` is the fastest
way to find what shipped recently.

### 2. Revert + build + smoke

```bash
git revert <sha>          # may need --no-edit on a chain
npm run build
npm test
```

The revert may conflict with unrelated edits to the same files; resolve
to the pre-revert behavior and re-run the smoke suite.

### 3. Drain in-flight canonical ops before deploy

In-flight canonical ops are in-process — restarting the host process
cancels them. Either:

- **Wait it out.** Interactive ops typically finish in seconds.
  `op_status(op_id)` reports state.
- **Cancel them.** `opCancel(op_id, actor)` runs the canonical cancel
  path (PRD §13, Issue 06).

```bash
# Anything in {queued, running, paused, cancelling} is still active.
grep -l '"state": "running"' ~/.lax/operations/*/operation.json
```

### 4. Deploy

Bring the host process down and back up on the reverted build.

### 5. Capture the incident

Record:

- The revert (commit SHA, who shipped it, when).
- The triggering symptom and ticket / log link.
- The list of canonical ops in flight at the moment of restart and how
  they drained (succeeded / failed / cancelled).
- A pointer to the failing test or invariant if any (Issue 10 compat
  fixtures, Issue 11 invariants).

---

## What rollback does NOT do

- It does **not** delete canonical artifacts on disk. `op_events`,
  `op_turns`, `op_messages` for canonical-routed ops stay. This is
  deliberate — they're the audit trail for the failure.
- It does **not** modify any in-flight op's routing. Per-op flag is
  immutable (PRD §17).
- It does **not** undo schema changes. Schema additions (PRD §9) are
  additive; pre-canonical callers ignore them.

---

## Re-shipping after fix

1. Land the fix on a separate commit. Add a regression test to the
   relevant Issue suite (`canonical-loop-NN-*.test.ts`).
2. Run the full suite locally and in CI:
   ```
   npx vitest run test/canonical-loop-*.test.ts
   npx tsc --noEmit -p tsconfig.json
   ```
3. Verify:
   - Issue 11 invariants + boundary audits green.
   - Issue 09 adapter conformance green.
4. Re-roll the fix on canary. Watch the same metrics that triggered the
   original rollback.

---

## Release markers — what each tag actually represents

`canonical-loop-v1.0` (the ship marker) was corrected on 2026-05-05 to
point at the post-seeding-fix commit `c2fa178`. The earlier `v1.0`
location (`613edad`) preceded the seeding fix and so marked a version
that did not actually execute user tasks. The corrected marker includes
Primal's production bootstrap wiring, the seeding parity fix, the
extended soak probes, and the Issue 16 follow-up doc.

`canonical-loop-v1.0-rc1` is intentionally left at `613edad` as the
audit marker for "what the pre-seeding-fix RC looked like." Anyone
inspecting the history can compare `rc1` (lifecycle-only) against
`v1.0` (full task execution) to see exactly what changed.

When in doubt, prefer `canonical-loop-v1.0` (= `c2fa178`) for canary or
rollback baselines. Do NOT pull from `rc1` for production —
canonical-routed ops there will succeed in lifecycle but the model will
not see the user's prompt.

---

## v1.0 history note: pre-seeding soak results are lifecycle-only

**Important context for anyone reading older soak/staging results.**

Between the v1.0 tag (`canonical-loop-v1.0`, `2026-05-04`) and commit
`32a29b8` (`2026-05-05`), every canonical-routed op shipped to the
Anthropic adapter with `messages: []` because the canonical loop had no
path to seed the user's task as the initial op_message. The model
received only the default system prompt ("You are a helpful
assistant.") and answered its empty context — typically with "What
would you like to work on?" — instead of the actual task. Every "PASS"
result in earlier soak / smoke artifacts proves only that the lifecycle
primitives (state machine, lease, recovery, replay, cancel, abort) work
correctly. **It does NOT prove task execution.**

Soak / probe runs collected before `32a29b8`:

- 50-op short soak, 2026-05-05 — lifecycle-only pass.
- 3-op long soak, 2026-05-05 — lifecycle-only pass; the 60–180 second
  responses were the model elaborating on its empty context, not
  executing the prompts.
- Production-path canary smoke `canary_prod_path_…` — lifecycle-only
  pass.
- Live Anthropic CLI smoke (Issue 09 gated suite) — lifecycle-only
  pass.

Task execution under canonical was first verified on 2026-05-05 by the
seed probe in `scripts/canonical-loop-seed-probe.ts` after `32a29b8`
landed (`CANONICAL_SEED_OK_123` round-trip). All later soaks (and any
future canary) actually exercise model task execution.

When triaging an incident or comparing "before / after" behavior on
canonical, do NOT cite pre-`32a29b8` soak success as evidence the
adapter was producing real responses. It wasn't.

---

## Related

- [docs/migration/worker-pool-retirement.md](../migration/worker-pool-retirement.md)
  — the three-phase plan; Phase 2 deletes the fork lifecycle this
  runbook used to roll back to.
- [docs/canonical-loop-prd.md](../canonical-loop-prd.md) — PRD,
  including §17 flag semantics and §22 Definition of Done.
- [src/canonical-loop/README.md](../../src/canonical-loop/README.md)
  — module map / boundary contract.
