# Harness Reliability Campaign

Status: implemented and verified

## Objective

Make long-running operations checkpoint safely instead of failing, and make
security decisions distinguish hard invariants from user-approvable policy
without weakening exfiltration controls.

## Invariants

- Genuine secret-path and tainted-egress denials remain fail-closed.
- Unattended runs never invent human approval.
- ARI audit events retain one tamper-evident process-wide chain.
- Quarantine and sticky run state do not leak across operations.
- `connectors/` is out of scope.

## Atomic Chunks

1. Pin regression contracts for policy disposition, ARI isolation, and
   iteration checkpoints.
2. Extend the canonical policy result with `hard-deny` and
   `approval-required`; route only the latter through the existing approval
   manager.
3. Scope ARI mutable firewall state by operation, with a shared audit store and
   explicit scope cleanup.
4. Treat the unattended iteration limit as checkpoint cadence, not terminal
   failure.
5. Surface checkpoint and policy outcomes without internal error jargon.
6. Run focused suites, the ARI security regressions, concurrency coverage, and
   the full build.

## Dependency Order

`regressions -> policy -> ARI -> checkpoints -> UX -> full verification`

Policy and ARI both touch tool enforcement, so they remain serial. Checkpoint
work may proceed only after the operation-scope identifier is stable.

## Verification Ledger

| Chunk | State | Verification |
| --- | --- | --- |
| Baseline and regression contracts | complete | focused suites pass |
| Canonical policy disposition | complete | 18 policy/approval tests pass |
| Operation-scoped ARI state | complete | isolation + shared-chain tests pass |
| Iteration checkpoint lifecycle | complete | worker + pause/resume suites pass |
| User-facing status and recovery | complete | event-pump and op-status coverage |
| Full build and skeptic review | complete with baseline caveats | 68 focused tests and 69/69 live harness checks pass; TypeScript and remaining build gates pass |

## Baseline Caveats

- `check:source-hygiene` is blocked by pre-existing `src/config.ts` (404
  lines) and `src/types.ts` (408 lines); neither file was changed here.
- The full Vitest run passed 7,084 tests and failed 25 unrelated baseline or
  environment-dependent tests (Windows path expectations, missing service
  dependencies/mocks, one existing tool-registry coverage gap, and timing).
