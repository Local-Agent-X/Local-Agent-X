# Canonical-loop compatibility fixtures

These are **golden-master fixtures** for [Issue 10 — Old-path compatibility
fixtures](../../../docs/issues/canonical-loop/10-old-path-compat-fixtures.md)
(PRD acceptance #11).

## What they prove

The canonical-loop ships under a feature flag (`LAX_CANONICAL_LOOP_*`).
Parallel-run safety requires that:

- **Flag OFF**: `op_submit_async` returns the same response shape it
  returned before canonical-loop existed, persists the op the legacy
  way, and writes nothing to canonical tables (`op_events`, `op_turns`,
  `op_messages`).
- **Flag ON**: `op_submit_async` returns the **same response shape** as
  flag OFF (PRD §17 hard rule: "byte-for-byte identical regardless of
  flag value"), populates the canonical tables for the op, and does
  **not** write to legacy execution tables.

Each fixture in `legacy/*.json` records both the expected response
envelope and the expected post-submit disk artifacts under each flag
value. The driver test (`test/canonical-loop-10-old-path-compat.test.ts`)
runs every scenario against both flag values and asserts the actual
behavior matches the fixture exactly.

## File layout

```
fixtures/
  README.md            ← this file
  legacy/
    text-only.json     ← simple freeform request, interactive lane
    tool-using.json    ← research-style request, interactive lane
    background-lane.json ← non-default lane, exercises lane preservation
    large-input.json   ← 16 KB task string, exercises template stability
    error-input.json   ← empty task, early-return error envelope
```

## Field shapes

```jsonc
{
  "scenario": "<id>",
  "description": "<human-readable summary>",
  "args": {
    "task": "<string>",            // or "_taskLengthBytes": <int> for synth
    "type": "<freeform|research|...>",
    "lane": "<interactive|build|ide|background>"
  },
  "expected": {
    "response": {
      "isError": false,
      "content": "<template with <OPID> placeholder>"
    },
    "publicOp": { /* normalized op-disk fields */ },
    "flagOff": { /* artifact snapshot under LAX_CANONICAL_LOOP_*=0 */ },
    "flagOn":  { /* artifact snapshot under LAX_CANONICAL_LOOP_*=1 */ },
    "flagEnvVar": "<env name>"     // optional override for non-interactive lanes
  }
}
```

The `<OPID>` placeholder is substituted at run-time. Timestamps are
normalized to `<ISO_TS>` in any persisted field. See
`op-submit-fixtures-harness.ts` for the normalization rules.

## Scope: what these fixtures DO and DO NOT cover

**They cover** the externally-observable submit-time contract:

- The tool's `{ content, isError }` envelope.
- Loop-routing decision (`canonical` vs `legacy`) per flag.
- The persisted op's public fields (`id`, `type`, `task`, `lane`,
  `ownerId`, `visibility`, `status`, `attemptCount`).
- Disk-artifact presence/absence — which directories and JSONL files
  exist immediately after submit.
- Canonical event types written at submit time.

**They do NOT cover** worker-side execution. The harness intentionally
bypasses `submitOp(op)` (legacy worker pool) and the canonical
scheduler pump so the snapshot is deterministic and time-bounded. Worker
behavior is exercised by the per-issue test suites (Issues 03, 06, 08, 09).

## Refresh procedure

When the legacy path's externally-observable behavior INTENTIONALLY
changes (response template, persisted-op fields, etc.):

1. Make the legacy-path change on a separate, focused commit. Do **not**
   bundle a fixture refresh with substantive code changes — drift is
   easier to audit when the refresh commit is structural-only.
2. Re-run the driver test once to see what mismatches:
   ```
   npx vitest run test/canonical-loop-10-old-path-compat.test.ts
   ```
3. Update the affected fixture file(s) by hand. Each fixture is a
   small, human-readable JSON; explicit edits are preferred over a
   record-and-overwrite tool because they force the author to confirm
   each change is intentional.
4. Re-run the driver test until green.
5. Commit fixtures with a message like:
   `canonical-loop: refresh old-path compat fixtures — <reason>`.

If a fixture refresh is needed because the **canonical** path drifted,
the refresh is a regression — fix the canonical path instead of
updating the fixture.

## Source-drift guard

A separate test reads `src/workers/tools.ts` and asserts the literal
fragments of the response template still appear verbatim. If the tool
source moves to a different formatter (template literal moves into a
helper, wording changes, etc.), that test fails first — the fixture
mismatch is the symptom; the source-drift test is the diagnostic.
