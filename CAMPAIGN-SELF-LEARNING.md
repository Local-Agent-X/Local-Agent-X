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
| C5 | Provenance and capability envelope | C4 | in-flight |
| C6 | Learning modes and management API | C5 | in-flight |
| C7 | Usage and effectiveness feedback | C5 | pending |
| C8 | Safe refinement and rollback | C7 | pending |
| C9 | Learning nudges | C3 | green |
| C10 | Learning graph API | C6 | pending |
| C11 | Learning graph UI | C10 | green |
| C12 | Cross-seam integration and final gate | C6-C11 | pending |

## Decisions queue

None.

## Verification log

- C1 adversarial review drove lifecycle, identity, and ordering fixes: session identity is captured before terminal release; unknown sessions remain unknown rather than manufacturing conversation provenance; receipts preserve repeated ordered steps; op-id upsert makes writes idempotent; and evidence persists only after a successful terminal transition. Core 56 tests, forced-terminal 5 tests, TypeScript, diff checks, and final refutation passed.
- C2 verification: 14 focused tests, TypeScript, diff checks, and final adversarial refutation passed. Failure receipts cannot leak into parallel automation detectors; recent regressions lower confidence.
- C3 verification: 19 focused tests, TypeScript, diff checks, persistence reload, and adversarial refutation passed. Refutation caught unstable evidence-count IDs and meaningless archive revival; identities now use semantic anchors, rejected candidates observe a 30-day cooldown, and archived candidates require explicit restoration.
- C9 verification: 45 focused tests, TypeScript, diff checks, live-mode routing, and adversarial refutation passed. Assisted learning surfaces only reliable workflow candidates, requires stronger evidence plus an expired cooldown before resurfacing, and respects rejection state; autonomous learning emits at most one low-priority activity note and never requests review.
- C4 verification: durable learned-protocol storage and candidate drafting passed 14 focused tests, TypeScript, restart/tamper/traversal checks, idempotency checks, and adversarial refutation. Only outcome-proven workflow candidates draft; drafts remain undiscoverable; ordered tool identities, confidence, and immutable evidence provenance are preserved; unchanged evidence does not create versions and stronger evidence does.
- C11 verification: 4 focused happy-dom tests, TypeScript, optimistic-failure recovery, websocket refresh, and adversarial refutation passed. The learned-workflow card stays outside the 3D atlas and reuses the existing inspector for evidence, history, versions, and lifecycle controls.

## Completion buckets

### Shipped

- C1: committed outcome evidence with stable session provenance, ordered tool receipts, forced-terminal coverage, and op-id idempotency. Focused tests and independent refutation green.
- C2: outcome-aware pattern mining with distinct-session confidence, recency weighting, failure exclusion, and collision-safe workflow grouping.
- C3: durable learned-candidate records with stable IDs, evidence snapshots, confidence, validated lifecycle transitions, rejection cooldowns, archive suppression, and transition history.
- C4: verified immutable learned-protocol storage plus deterministic, outcome-proven candidate drafting with active-only discovery and exact tool-order provenance.
- C9: quiet mode-aware learning nudges with durable deduplication, evidence-growth gating, cooldowns, rejection memory, and low-priority autonomous activity signals.
- C11: compact Memory-tab learned-workflow management UI with assisted/autonomous presentation, existing-inspector detail, lifecycle controls, websocket refresh, and optimistic rollback.

### Parked for user

None.

### Failed and abandoned

None.

### Descoped

- Existing repository references unrelated to campaign changes.
- New messaging channels, mobile applications, marketplace commerce, licensing changes, push, and deployment.
