# Issue 02 — Fake adapter + acceptance harness

**Phase:** Foundation
**Blocks:** 03, 05, 06, 07, 08, 11
**Blocked by:** None (parallelizable with 01)

---

## Goal

Build the deterministic, programmable fake adapter that conforms to the locked adapter contract, plus the acceptance test harness that drives canonical-loop end-to-end without real provider I/O. This is the test substrate for every other v1 issue.

## Why it matters

The PRD locks the adapter contract at v1.0 and requires that all 11 acceptance tests run against a fake adapter (real Anthropic CLI is reserved for smoke). Without this fake + harness landed early, every subsequent issue duplicates ad-hoc test rigging. The fake adapter is also our living conformance fixture: anything Codex (v1.1) needs to do can be cross-checked against the fake's behavior.

## Scope

- Implement `FakeAdapter` conforming to the [PRD §15 contract](../../canonical-loop-prd.md#15-adapter-contract):
  - `runTurn(input, report)` programmable via a script of pre-arranged `adapter_report` items and a final `TurnResult`.
  - `abort()` resolves promptly, idempotent, safe after completion.
  - `provider_state` envelope round-trip with adapter_name `"fake"`, version, opaque payload.
- Implement an acceptance harness:
  - Spins up an in-memory or transactional DB (existing test infra).
  - Provides helpers: `submitOp(input, lane='interactive')`, `awaitState(op_id, state)`, `assertEvents(op_id, expected)`, `assertOpTurns(op_id, expected)`, `assertOpMessages(op_id, expected)`.
  - Provides scripted-adapter helpers: `scriptTurn(messages, tools, terminal)`, `scriptMultiTurn(...)`.
  - Captures bus traffic for assertions on stream chunks.
- Implement adapter conformance test runner that takes any adapter and runs items A–I (PRD §15). Used here against `FakeAdapter`; reused in issue 09 against Anthropic adapter.
- Helpers for crash simulation (forcibly reject the worker promise, simulate lease expiry).
- Helpers for clock control (advance time for lease expiry tests).

## Non-goals

- Real Anthropic CLI invocation (issue 09).
- Implementing canonical-loop logic itself (issue 03 onward).
- Performance benchmarking.
- Recording/replaying real provider transcripts.

## Likely files / modules

- `tests/canonical-loop/fake-adapter.ts` — programmable adapter.
- `tests/canonical-loop/harness.ts` — submit/await/assert helpers.
- `tests/canonical-loop/conformance.ts` — adapter conformance suite runner.
- `tests/canonical-loop/clock.ts` — fake clock for lease tests.
- `tests/canonical-loop/bus-recorder.ts` — captures `op_stream:{op_id}` and event bus traffic.

## Dependencies / blockers

- None. Can start in parallel with issue 01 — the harness can be drafted against the planned schema and wired up once 01 lands.

## Acceptance criteria

- `FakeAdapter` passes conformance suite items A–G against itself with no canonical-loop code present (smoke test of the contract type signatures alone).
- Harness can submit an op and observe DB state without poking real adapters.
- Crash simulation can forcibly drop a worker mid-turn.
- Clock helper can advance time deterministically for lease expiry.
- Conformance runner is pure: takes any `Adapter`, returns pass/fail per item with diagnostic output.

## Tests required

- Self-test: run conformance suite A–G against `FakeAdapter`. All pass.
- Self-test: harness can detect a missing event, a bad seq, a missing turn, a missing state row, and surface clear failure messages.
- Self-test: bus recorder captures stream chunks emitted by `FakeAdapter` and matches expected sequence.

## Definition of done

- [ ] `FakeAdapter` implements full adapter contract (`runTurn`, `abort`, provider_state envelope).
- [ ] Acceptance harness available with the helper API documented in a README under `tests/canonical-loop/`.
- [ ] Conformance suite runner usable from any test file.
- [ ] Crash + clock simulation documented and exercised by self-tests.
- [ ] No production code modified by this issue. Tests-only.
- [ ] All new test modules ≤ 400 LOC each.
