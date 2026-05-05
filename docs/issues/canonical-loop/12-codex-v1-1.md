# Issue 12 — Codex adapter (v1.1) — boundary proof

**Phase:** v1.1 — provider-neutrality proof
**Status:** Design landed 2026-05-05 ([12-codex-v1-1-design.md](12-codex-v1-1-design.md)). Implementation gated on ≥1 week of v1.0 canary clean.
**Blocks:** Issue 13 (build v1.2)

---

## Goal

Implement the Codex adapter against the locked v1.0 contract — without contract changes — and prove canonical-loop is genuinely provider-neutral by running the full conformance suite + real Codex CLI smoke. This is the second adapter, and the first real test that the boundary holds in code.

## Why it matters

Until two adapters run on the same loop, the adapter boundary is theoretical. v1.1 shipping means the loop has paid for its name: a real Codex op runs through the same state machine, the same checkpoint, the same control plane, and the same event log as Anthropic, with zero loop changes.

## Scope

- New module `src/canonical-loop/adapters/codex.ts` (or similar) implementing the same `Adapter` interface from PRD §15.
- `provider_state` envelope: `{adapter_name: "codex", adapter_version: "<semver>", provider_payload: {...}}`. Codex chooses its own payload contents; loop never parses.
- `abort()` honors the same contract.
- Adapter wraps the existing already-unified Codex executor (per memory). Do not modify the executor.
- Wire the Codex adapter behind flag ON for `interactive` lane when provider routing selects Codex.
- Run full conformance suite A–I (locked at v1.0) against the Codex adapter without altering the suite.

## Hard constraint

**No adapter contract changes.** If something doesn't fit, the *Codex adapter* adapts — the contract does not. The only allowable contract change is in response to a true loop bug discovered during v1.0, and that is a separate Issue, not part of v1.1.

## Non-goals

- Modifying canonical-loop, fake adapter, conformance suite runner, or Anthropic adapter.
- Modifying Codex executor unification.
- Modifying tool-executor.
- New lane work (build / IDE).
- New event types.

## Likely files / modules

- `src/canonical-loop/adapters/codex.ts` — main adapter.
- `src/canonical-loop/adapters/codex-stream-parse.ts` — if needed.
- `tests/canonical-loop/codex-conformance.test.ts` — runs conformance suite.
- `tests/canonical-loop/codex-smoke.test.ts` — gated real CLI smoke.

## Dependencies / blockers

- v1.0 tagged and shipped (issues 01–11).
- Existing Codex executor unification (untouchable).

## Acceptance criteria

- Codex adapter passes all 9 conformance items A–I.
- Real Codex CLI smoke (3–5 tests) green:
  - End-to-end happy path through canonical-loop.
  - Cancel mid-stream.
  - Crash recovery via `provider_state` round-trip.
- Anthropic adapter still passes all conformance items unchanged (no regression).
- Zero diff on canonical-loop modules, fake adapter, conformance runner, or Anthropic adapter.
- Sandbox audit: Codex adapter has no DB / event-writer / worker-pool imports.

## Tests required

- All 9 conformance items A–I against Codex.
- 3–5 real Codex CLI smoke tests.
- Re-run Anthropic conformance suite to prove no regression.

## Definition of done

- [ ] Codex adapter passes all conformance items.
- [ ] Real CLI smoke green.
- [ ] No contract changes.
- [ ] No regression in Anthropic adapter or canonical-loop.
- [ ] No untouchable modified.
- [ ] Module sizes within 400 LOC.
- [ ] Tag v1.1.
