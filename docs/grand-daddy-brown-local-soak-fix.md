# Local soak reliability campaign

Goal: make local-model tool turns continue correctly and align `web_search` validation with its canonical multi-query contract.

## Scope

| Chunk | Status | Seam | Footprint | Depends on |
|---|---|---|---|---|
| C1 web-search schema | green | `webSearchTool.parameters` | `src/tools/web-search-tool.ts`, `src/tools/web-search-tool.test.ts` | none |
| C2 silent-tool continuation | green | `decideTurnOutcome()` | `src/canonical-loop/turn-loop/decide-outcome.ts`, `src/canonical-loop/turn-loop/decide-outcome.test.ts` | C1 verification gate |
| C3 integration proof | green | canonical drive loop across a narrated browser tool result | `src/canonical-loop/full-turn.test.ts` | C2 |
| C4 build runtime propagation | green | core `build_app` runtime provider/model handoff | `src/tools/plugins.ts`, `src/tools/plugins.test.ts` | C2 |

## Done list

- `web_search` accepts either `query` or `queries` and rejects neither valid form at schema validation.
- An explicit model continuation signal overrides silent-tool completion.
- Browser scroll with `modelStop: continue` receives another inference turn.
- Focused tests, typecheck, full build, and relevant broader tests are run.
- Each chunk survives independent adversarial review.
- Each green chunk is committed separately. Nothing is pushed.

## Conflict and dependency graph

`C1 -> verification/refutation -> C2 -> verification/refutation -> C3 -> integration gate`

C1 and C2 have disjoint footprints, but C2 changes a provider-wide completion anchor and is deliberately held behind the C1 gate.

## Blast radius

- C1 affects all providers that receive the canonical `web_search` schema. Runtime already enforces the at-least-one-query invariant.
- C2 affects all providers and all silent tool categories, but only when a provider explicitly reports that it wants to continue.
- Existing no-signal and explicit-done completion behavior must remain unchanged.

## Out of scope

- Prompt trimming or automatic lean-profile routing.
- Changing which browser actions count as silent.
- Generic argument alias or repair middleware.
- Deployment or push.

## Decisions and findings

- Canonical-check verdict: extend `webSearchTool` and `decideTurnOutcome`; create no parallel subsystem.
- Live failure evidence: Gemma emitted valid `queries`, then LAX validation rejected it because the schema still required `query`.
- Live failure evidence: Gemma emitted a narrated browser scroll with an explicit tool continuation, but `allSilent` terminated the operation.
- Live failure evidence: `op_app_build_ef2ffcc9c67a4cb1` failed immediately with `404 model 'qwen2:7b' not found` while the active local model was `google/gemma-4-e4b`. The runtime relay wrapper was attached to `appTools`, which does not contain `build_app`; the actual definition lives in the core plugin.

## Completion ledger

Integration gate: source hygiene, no-require, docs consistency, codebase map, pricing coverage, Ari build, TypeScript build, and bundled-protocol copy all passed. The full Vitest run passed except one unrelated 15-second timeout in `side-effect-crash-resume.test.ts`; that file passed 6/6 immediately when rerun alone.

### Shipped (green)

- C1: canonical schema accepts `query` or `queries`; runtime retains the empty-input rejection. Focused tests: 8/8; typecheck passed; skeptic verdict: HOLDS.
- C2: explicit continuation now overrides silent completion when an otherwise-silent batch contains a browser action. Voice-only and memory-only behavior is preserved. Relevant tests: 53/53; typecheck passed; skeptic verdict: HOLDS after two caught-and-corrected edge cases.
- C3: real canonical scheduler/worker/turn-loop test proves narrated browser scroll continues through the tool result to a second inference and final answer. Full-turn tests: 3/3; skeptic verdict: HOLDS.
- C4: the real core `build_app` definition now receives the active session provider/model without mutating or leaking call arguments; registry metadata and bridge visibility are preserved. Focused tests: 19/19; typecheck passed; skeptic verdict: HOLDS after correcting partial-override and reused-argument defects.

### Parked for user

None.

### Failed and abandoned

None. One full-suite crash-resume test timed out under parallel suite load and passed on isolated rerun; no campaign code participates in that subsystem.

### Descoped

Prompt trimming remains a separate telemetry-driven campaign.
