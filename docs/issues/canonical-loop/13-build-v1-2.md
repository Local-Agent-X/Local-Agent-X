# Issue 13 — `build` lane + `build_app` adapter (v1.2)

**Phase:** v1.2 — long-tool / lane scheduling proof
**Status:** **BLOCKED** by v1.1 completion (Codex adapter green, v1.1 tagged).
**Blocks:** Issue 14 (IDE v1.3)

---

## Goal

Bring the `build_app` flow onto canonical-loop by introducing the `build` lane and a `build_app` adapter that conforms to the same locked contract. Validates lane caps, long-tool semantics, and adapter idempotency strategies. Routes traffic behind feature flag `lax.canonical_loop.build` (default OFF, opt-in canary).

## Why it matters

`build_app` is the long-running, special-cased path most likely to expose loop bugs around mid-turn duration, tool-executor interaction, and lane scheduling. Successfully migrating it proves canonical-loop scales beyond chat-style interactive ops.

## Scope

- New `build_app` adapter: implements Adapter interface; wraps existing build_app subagent invocation without modifying it.
- New `build` lane:
  - Cap defaults to 2 (per PRD §21).
  - FIFO within lane.
  - Concurrent build ops allowed up to cap.
- `op_submit_async` routes build submissions into `lane='build'` when canonical flag for `build` is ON.
- Long-tool semantics:
  - No mid-turn checkpoints (PRD-locked). build_app's internal long step is treated as a single tool call from the loop's perspective.
  - build_app is responsible for its own idempotency or recovery if the worker dies mid-tool. Document in adapter README.
- Run full conformance suite A–I against the build_app adapter.
- Real-build smoke: at least one real build_app run end-to-end through canonical-loop.

## Hard constraint

**No contract changes.** Any pain points become follow-up issues, not contract revisions.

## Non-goals

- Modifying build_app subagent internals.
- Modifying tool-executor.
- IDE lane (issue 14).
- Multi-step build_app checkpoint sub-states inside a turn.

## Likely files / modules

- `src/canonical-loop/adapters/build-app.ts` — adapter wrapping build_app invocation.
- `src/canonical-loop/scheduler.ts` — lane cap config wiring (additive).
- `tests/canonical-loop/build-conformance.test.ts`.
- `tests/canonical-loop/build-smoke.test.ts` — gated real build smoke.

## Dependencies / blockers

- v1.1 tagged (issue 12).
- Existing build_app subagent flow (untouchable).

## Acceptance criteria

- `build_app` adapter passes all 9 conformance items.
- Real build smoke: end-to-end build_app through canonical-loop completes successfully behind flag ON.
- Lane cap = 2 enforced: 3 concurrent build submissions → 2 active, 1 queued; FIFO holds.
- No regression in v1.0 / v1.1 acceptance + conformance.
- No diff in build_app subagent or tool-executor.

## Tests required

- 9 conformance items against build_app adapter.
- Real build smoke (gated CI).
- Lane-cap test: submit 3 concurrent builds, observe scheduling.
- Cancel mid-build: adapter.abort() actually halts the build process (no leaked subprocess).
- Crash recovery during a build: provider_state round-trip restores the build context if applicable; otherwise op transitions `failed` cleanly with documented reason.

## Definition of done

- [ ] build_app adapter passes conformance.
- [ ] Real build smoke green.
- [ ] `build` lane cap=2 enforced and tested.
- [ ] No regression in earlier suites.
- [ ] No untouchable modified.
- [ ] Tag v1.2.
