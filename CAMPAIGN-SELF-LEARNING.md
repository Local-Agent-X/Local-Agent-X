# Self-Learning Campaign Ledger

## Goal

Build a native Local-Agent-X closed learning loop that turns successful repeated workflows into automatically selected, versioned, outcome-scored learned protocols while preserving existing security boundaries.

## Product policy

- `assisted`: draft learned protocols and wait for activation.
- `autonomous`: create, activate, select, refine, demote, and roll back learned protocols without per-protocol prompts.
- Existing trusted protocols may be selected automatically in either mode.
- A learned protocol cannot expand the user's existing capability or permission envelope.
- Underlying actions retain their existing Ari, policy, approval, sandbox, workspace, and egress gates.

## Campaign invariants

- Extend canonical Local-Agent-X seams; do not create parallel subsystems.
- New campaign material uses only native Local-Agent-X terminology.
- Existing repository references outside campaign changes are out of scope.
- Every production change has focused behavioral tests.
- Every green chunk receives independent verification and adversarial review.
- Every campaign commit ends with the exact trailer `Assisted-by: Codex`.
- Never push.

## Status

| Chunk | Responsibility | Dependencies | Status |
|---|---|---|---|
| C1 | Outcome evidence bridge | none | green |
| C2 | Outcome-aware pattern mining | C1 | green |
| C3 | Learned-candidate lifecycle | C2 | green |
| C4 | Learned protocol drafting | C3 | green |
| C5 | Provenance and capability envelope | C4 | green |
| C6 | Learning modes and management API | C5 | green |
| C7 | Usage and effectiveness feedback | C5 | green |
| C8 | Safe refinement and rollback | C7 | green |
| C9 | Learning nudges | C3 | green |
| C10 | Learning graph API | C6 | green |
| C11 | Learning graph UI | C10 | green |
| C12 | Cross-seam integration and final gate | C6-C11 | green |

## Decisions queue

None.

## Verification log

- C1 adversarial review drove lifecycle, identity, and ordering fixes: session identity is captured before terminal release; unknown sessions remain unknown rather than manufacturing conversation provenance; receipts preserve repeated ordered steps; op-id upsert makes writes idempotent; and evidence persists only after a successful terminal transition. Core 56 tests, forced-terminal 5 tests, TypeScript, diff checks, and final refutation passed.
- C2 verification: 14 focused tests, TypeScript, diff checks, and final adversarial refutation passed. Failure receipts cannot leak into parallel automation detectors; recent regressions lower confidence.
- C3 verification: 19 focused tests, TypeScript, diff checks, persistence reload, and adversarial refutation passed. Refutation caught unstable evidence-count IDs and meaningless archive revival; identities now use semantic anchors, rejected candidates observe a 30-day cooldown, and archived candidates require explicit restoration.
- C9 verification: 45 focused tests, TypeScript, diff checks, live-mode routing, and adversarial refutation passed. Assisted learning surfaces only reliable workflow candidates, requires stronger evidence plus an expired cooldown before resurfacing, and respects rejection state; autonomous learning emits at most one low-priority activity note and never requests review.
- C4 verification: durable learned-protocol storage and candidate drafting passed 14 focused tests, TypeScript, restart/tamper/traversal checks, idempotency checks, and adversarial refutation. Only outcome-proven workflow candidates draft; drafts remain undiscoverable; ordered tool identities, confidence, and immutable evidence provenance are preserved; unchanged evidence does not create versions and stronger evidence does.
- C11 verification: 4 focused happy-dom tests, TypeScript, optimistic-failure recovery, websocket refresh, and adversarial refutation passed. The learned-workflow card stays outside the 3D atlas and reuses the existing inspector for evidence, history, versions, and lifecycle controls.
- C5 verification: operation-scoped learned-protocol envelopes passed 28 focused tests, TypeScript, source hygiene, restart persistence, conflict detection, per-tool provenance revalidation, and independent refutation. Learned allowlists only narrow the normal authorization path; forged operation IDs, stale versions, modified bodies, and removed protocols fail closed while ordinary imported protocols remain compatible.
- C6 verification: the assisted/autonomous coordinator, immutable-evidence repair, and automatic learned-workflow selector passed 54 combined focused tests, TypeScript, source hygiene, and independent refutation. Assisted mode drafts and waits; autonomous mode activates quietly; every-message selection admits only verified active candidate-linked protocols and injects a short canonical loading hint without bodies, evidence, or permissions.
- C10 verification: the authenticated learning graph API passed 15 route-and-UI contract tests, TypeScript, source hygiene, and adversarial payload review. Read endpoints expose the service view, mutations require operator role, payloads are strict, stale version writes return conflicts, and the exact UI reject payload is accepted without weakening validation.
- C7 verification: the terminal feedback bridge passed 120 focused and forced-path checks across normal completion, iteration checkpoints, token and deadline exhaustion, adapter and worker exceptions, cancellation, restart recovery, and state mismatch quarantine. Provenance is captured before terminal cleanup, pending receipts precede durable terminal writes, committed receipts follow them, ordinary work still feeds candidate mining, and replay preserves original timestamps.
- C8 verification: safe refinement passed 72 cross-concern tests plus combined campaign refutation. Promotion requires stronger high-quality evidence; assisted mode waits; autonomous mode uses compare-and-swap; committed activation-scoped regression windows trigger rollback in both modes or archival when no healthy prior exists. Mutable bounded activation history remains separate from immutable protocol versions.
- C8 follow-up verification: the cross-seam proof exposed that an assisted refinement draft could remain inactive after switching to autonomous mode. The production repair passed 18 focused tests and a 59-test safety/lifecycle matrix, activates only statistically self-consistent stronger drafts for the same candidate, remains idempotent across cooldowns and restarts, rejects tampered or safety-rejected versions, and gives rollback precedence over forward activation.
- C12 verification: the strict production-seam test passed three consecutive runs and then passed again after an added false-positive rollback assertion. It proves ordinary canonical outcomes through mining, assisted drafting, autonomous activation, every-message selection, trusted operation provenance, narrowing-only capability enforcement, exact effectiveness receipts, stronger refinement, mode-independent rollback, stale-envelope shutdown, immutable prior versions, cancellation exclusion, and persistence-interrupted restart recovery. The 20-file campaign matrix passed 131 tests; the final changed-test matrix passed all 22 files and 182 tests.
- Independent final refutation: a separate skeptic returned SHIP after rerunning C12 (3 tests) and a targeted C5-C8 production-wiring matrix (8 files and 71 tests). It confirmed real model-facing selection, forged-operation-ID replacement, narrowing-only authority, terminal persistence ordering, cancellation exclusion, activation-bounded chronological rollback, safety-rejected-version suppression, and fail-closed tamper handling.
- Final gates: TypeScript, source hygiene (2,176 files and no grandfathered violations), no-`require`, documentation consistency, generated codebase-map validation, pricing coverage, the full production build, and all 22 offline instruction-compliance cases passed. All 25 campaign commits carry the exact `Assisted-by: Codex` trailer, the worktree is clean, and changed campaign lines contain none of the prohibited comparison-project names.
- Repository-wide baseline context: the legacy `npm test` harness remains at 53/55 on both this campaign and untouched main for the same unrelated missing security-policy route/module. The unconstrained all-suite Vitest run remains dominated by existing environment failures (native SQLite ABI, sandbox loopback restrictions, Electron availability, and platform path differences). Campaign-focused matrices, coupled-consumer tests, and final build are green; no unrelated baseline behavior was altered to manufacture a green result.

## Completion buckets

### Shipped

- C1: committed outcome evidence with stable session provenance, ordered tool receipts, forced-terminal coverage, and op-id idempotency. Focused tests and independent refutation green.
- C2: outcome-aware pattern mining with distinct-session confidence, recency weighting, failure exclusion, and collision-safe workflow grouping.
- C3: durable learned-candidate records with stable IDs, evidence snapshots, confidence, validated lifecycle transitions, rejection cooldowns, archive suppression, and transition history.
- C4: verified immutable learned-protocol storage plus deterministic, outcome-proven candidate drafting with active-only discovery and exact tool-order provenance.
- C9: quiet mode-aware learning nudges with durable deduplication, evidence-growth gating, cooldowns, rejection memory, and low-priority autonomous activity signals.
- C11: compact Memory-tab learned-workflow management UI with assisted/autonomous presentation, existing-inspector detail, lifecycle controls, websocket refresh, and optimistic rollback.
- C5: restart-safe, operation-scoped learned-protocol provenance and capability envelopes that fail closed and can only narrow existing gates.
- C6: seamless assisted/autonomous coordination plus conservative automatic selection of verified active learned workflows on every message.
- C10: authenticated list, detail, and lifecycle-action routes with operator-only mutation, strict validation, conflict handling, and live refresh broadcasts.
- C7: restart-repairable, envelope-attributed effectiveness receipts with pending-before-terminal and commit-after-terminal ordering, while preserving ordinary candidate mining and excluding user cancellation.
- C8: thresholded refinement, assisted waiting, autonomous compare-and-swap activation, and mode-independent safety rollback with healthy-prior selection and archival fallback.
- C12: an adversarial production-seam proof for the complete learning loop, including both policy modes, narrowing-only authority, outcome feedback, safe refinement, rollback, stale provenance, immutable history, and restart repair.

### Parked for user

None.

### Failed and abandoned

None.

### Descoped

- Existing repository references unrelated to campaign changes.
- New messaging channels, mobile applications, marketplace commerce, licensing changes, push, and deployment.
