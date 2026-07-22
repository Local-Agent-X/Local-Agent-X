# Canonical-loop rollback runbook

**Audience:** on-call / shipper.
**Scope:** the LAX canonical op loop (sole execution path since the worker-pool retirement landed 2026-05-15).
**Runtime references:** [`src/canonical-loop/README.md`](../../src/canonical-loop/README.md)
and PRD [§17](../canonical-loop-prd.md#17-feature-flag--parallel-run-strategy).
PRD §22 is an archived v1.0 ship checklist, not an operational procedure.

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
- `op_submit_async` response shape regresses (the Issue 10 golden-master
  fixtures in `test/canonical-loop/fixtures/` capture the contract; note
  there is currently no automated test wired to replay them).
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

`git log --oneline -- src/canonical-loop/ src/ops/` is the fastest
way to find what shipped recently.

### 2. Revert + build + smoke

```bash
git revert <sha>          # may need --no-edit on a chain
npm run build
npx vitest run test/canonical-loop-*.test.ts
```

(`npm test` is the live integration suite — it needs a running server, so
it is the wrong verification step mid-rollback; the scoped vitest run above
covers the canonical-loop invariants.)

The revert may conflict with unrelated edits to the same files; resolve
to the pre-revert behavior and re-run the Issue 09 adapter conformance
suite (`test/canonical-loop-09-anthropic-conformance.test.ts`).

### 3. Drain in-flight canonical ops before deploy

In-flight canonical ops are in-process — restarting the host process
cancels them. Either:

- **Wait it out.** Interactive ops typically finish in seconds.
  `op_status(op_id)` reports state.
- **Cancel them.** `opCancel(op_id, actor)` runs the canonical cancel
  path (PRD §13, Issue 06).

```bash
# Anything in {queued, running, paused, cancelling} is still active.
grep -lE '"state": "(queued|running|paused|cancelling)"' ~/.lax/operations/*/operation.json
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

## Related

- [docs/canonical-loop-prd.md](../canonical-loop-prd.md) — PRD,
  including §17 flag semantics and §22 Definition of Done.
- [src/canonical-loop/README.md](../../src/canonical-loop/README.md)
  — module map / boundary contract.
