# Canonical-loop rollback runbook

**Audience:** on-call / shipper.
**Scope:** v1.0 of the LAX Canonical Operation Loop, behind feature
flags `LAX_CANONICAL_LOOP_*`.
**Source of truth:** [PRD §17 / §22](../canonical-loop-prd.md).

The canonical loop is a per-lane feature flag. Rollback is a flag flip,
not a code change.

---

## TL;DR

```bash
# Roll back a specific lane (example: interactive):
unset LAX_CANONICAL_LOOP_INTERACTIVE
# Or set explicitly to a falsy value:
export LAX_CANONICAL_LOOP_INTERACTIVE=0

# Roll back ALL lanes at once (overrides per-lane flags):
unset LAX_CANONICAL_LOOP_ALL
export LAX_CANONICAL_LOOP_ALL=0
```

Restart the host process. New `op_submit_async` calls route to legacy.
Already-submitted canonical ops keep running on canonical-loop until
they complete — **the flag is captured per-op at submission time and is
immutable for the op's lifetime** (PRD §17).

---

## What the flags control

| Env var | Effect |
|---|---|
| `LAX_CANONICAL_LOOP_INTERACTIVE` | Routes the `interactive` lane through canonical-loop when truthy. |
| `LAX_CANONICAL_LOOP_BUILD` | Same for the `build` lane. |
| `LAX_CANONICAL_LOOP_IDE` | Same for the `ide` lane. |
| `LAX_CANONICAL_LOOP_BACKGROUND` | Same for the `background` lane. |
| `LAX_CANONICAL_LOOP_ALL` | Catch-all override. When truthy, every lane routes canonical regardless of per-lane flags. |

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Anything
else — including absent — is OFF.

The flag is read once per `op_submit_async` call by `decideSubmitRouting`.
The result is stamped onto `ops.canonical_flag_value` and never re-read.

---

## When to roll back

Roll back if any of these are observed on canary:

- A canonical op gets stuck in `running` past its lease window AND
  `recoverStaleOp` doesn't restore it.
- `op_events` seq gaps appear for any op (per-op monotonic invariant
  broken — Issue 11 invariants test would catch this on the canary
  path before prod).
- `op_submit_async` response shape diverges from the legacy fixture
  (Issue 10 compat test would catch this).
- Adapter conformance fails on a real-CLI smoke (Issue 09 gated suite).
- A worker crash leaves the lease unrecovered AND a replacement
  worker can't take over.
- A user-visible regression vs the legacy path (terminal events
  missing, status response missing fields, etc.).

If symptoms are **adapter-specific** (Anthropic-only / Codex-only),
prefer disabling that lane only — leave other lanes on canonical.

---

## Rollback procedure

### 1. Identify the lane(s) to disable

If the bug is reproducible against `interactive` only, only disable
`interactive`. Other lanes can stay on canary.

### 2. Flip the flag

In whatever environment-variable surface your host uses
(systemd unit, supervisor config, container env, shell rc, etc.):

```bash
# Per-lane:
unset LAX_CANONICAL_LOOP_INTERACTIVE
# Or:
export LAX_CANONICAL_LOOP_INTERACTIVE=0

# Global kill switch (overrides everything):
export LAX_CANONICAL_LOOP_ALL=0
```

Bring the host process down and back up. **New** `op_submit_async`
calls will route to legacy.

### 3. Drain in-flight canonical ops

Already-submitted canonical ops have their `canonical_flag_value=true`
captured on the op row. They keep running on canonical-loop until they
hit a terminal state. **Do not force-flip them to legacy** — the loop's
state machine and adapter contract own those ops; mid-flight rerouting
is forbidden by PRD §17.

Two drain strategies:

- **Wait it out.** Canonical interactive ops typically finish in
  seconds. `op_status(op_id)` reports their state.
- **Cancel them.** `opCancel(op_id, actor)` runs through the canonical
  cancel path (PRD §13, Issue 06). The op transitions to `cancelled`
  cleanly with `adapter.abort()` invoked.

Verify drain:

```bash
# Walk the operations directory; canonical state is on op.canonical.state.
# Anything in {queued, running, paused, cancelling} is still active.
grep -l '"state": "running"' ~/.lax/operations/*/operation.json
```

### 4. Confirm legacy is serving new ops

Submit a probe op via the chat UI (or `op_submit_async` directly).
Inspect the on-disk op:

```bash
cat ~/.lax/operations/<probe-op-id>/operation.json | jq '.canonical'
```

For a legacy-routed op the `canonical` field should be **absent** (or
`{ "flagValue": false }` if you wrote it that way during the canary).
For a canonical-routed op `canonical.flagValue` is `true`.

### 5. Capture the incident

Record:

- The flag flip (which lane, who flipped, when).
- The triggering symptom and ticket / log link.
- The list of canonical ops in flight at the moment of flip and how
  they drained (succeeded / failed / cancelled).
- A pointer to the failing test or invariant if any (Issue 10 compat
  fixtures, Issue 11 invariants).

This captures the rollback in the audit trail and feeds the post-mortem.

---

## What rollback does NOT do

- It does **not** delete canonical artifacts on disk. `op_events`,
  `op_turns`, `op_messages` for canonical-routed ops stay. This is
  deliberate — they're the audit trail for the failure.
- It does **not** modify any in-flight op's routing. Per-op flag is
  immutable (PRD §17).
- It does **not** undo schema changes. Schema additions (PRD §9) are
  additive; legacy callers ignore them. No migration needed to roll
  back.
- It does **not** clear in-process scheduler state. A clean restart
  resets the scheduler; just bouncing the env var without restart
  leaves any active workers running.

---

## Re-enabling after fix

1. Land the fix on a separate commit. Add a regression test to the
   relevant Issue suite (`canonical-loop-NN-*.test.ts`).
2. Run the full suite locally and in CI:
   ```
   npx vitest run test/canonical-loop-*.test.ts
   npx tsc --noEmit -p tsconfig.json
   ```
3. Verify:
   - Issue 10 old-path compat fixtures green for both flag values.
   - Issue 11 invariants + boundary audits green.
   - Issue 09 adapter conformance green.
4. Re-flip the flag on canary. Watch the same metrics that triggered
   the original rollback.

---

## Related

- [docs/canonical-loop-prd.md](../canonical-loop-prd.md) — PRD,
  including §17 flag semantics and §22 Definition of Done.
- [docs/issues/canonical-loop/README.md](../issues/canonical-loop/README.md)
  — issue board.
- [test/canonical-loop/fixtures/README.md](../../test/canonical-loop/fixtures/README.md)
  — Issue 10 compat-fixture refresh procedure.
- [src/canonical-loop/README.md](../../src/canonical-loop/README.md)
  — module map / boundary contract.
