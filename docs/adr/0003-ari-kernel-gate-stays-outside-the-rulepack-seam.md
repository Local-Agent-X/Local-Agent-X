# ADR 0003 — The ARI kernel gate stays outside the RulePack seam

Status: Accepted — 2026-07-11

## Context

Tool-call vetoes flow through three interfaces today:

- **The phase chain.** `src/tool-execution/execute-tool.ts` composes
  resolve → policy → approval → sandbox → audit; each phase returns a
  `PhaseOutcome` (`continue` / `halt` / `block`, defined in
  `src/tool-execution/context.ts:61`).
- **Pre-dispatch throws.** `src/tools/pre-dispatch.ts` gates by throwing
  `ToolBlocked` (`pre-dispatch.ts:50`) with a stage + disposition;
  `enforce-policy.ts:180` catches it and converts it back into a phase
  outcome.
- **The unified RulePack seam.** `src/tool-policy/evaluator.ts:117` iterates
  sealed `RulePack`s in priority order, first deny wins. Pre-dispatch runs six
  packs through it (`pre-dispatch.ts:254`): spend-cap, security-layer,
  default-policy, threat-engine, arikernel, egress-refutation.

The real ARI kernel gate sits outside all three. `ariKernelGate`
(`src/tool-execution/enforce-policy.ts:65`) calls `ariEvaluate`
(`src/ari-kernel/evaluate.ts:57`), which drives `firewall.execute`
(`evaluate.ts:114`) and returns its own result shape —
`{ allowed, reason, quarantined?, userHint? }` — not a `PackDecision`. The
`arikernel` entry in the pack list is a no-op placeholder that always allows
(`src/tool-policy/packs/arikernel-pack.ts:41`); the deny-by-default posture it
"mirrors" is already enforced by the default-policy pack.

An architecture review proposed folding the kernel gate in as an async
RulePack. The pack contract does allow async (`evaluator.ts:91` accepts
`Promise<PackDecision>`), so asyncness is not the obstacle. The semantics are:

- **The kernel runs BEFORE pre-dispatch by design.** In
  `securityAndValidationGates` (`enforce-policy.ts:279`), `ariKernelGate` is
  the first gate — ahead of session policy, the worktree path rewrite, and the
  entire pack pass inside `runPreDispatch` (`enforce-policy.ts:286`). A pack
  slot would subordinate that ordering to the evaluator's priority sort.
- **Fail-closed contracts of its own.** A tool missing from `TOOL_CLASS_MAP`
  is an explicit block, not a fall-through (`evaluate.ts:77`); a required but
  inactive kernel blocks (`evaluate.ts:66`); an evaluation error in
  `ariRequired` mode blocks with the underlying detail surfaced
  (`evaluate.ts:163`). None of these map onto "first deny wins over sealed
  rules".
- **Taint-scope refresh and retry.** Foreign run-level taint on a clean call
  refreshes the ARI scope and re-evaluates once (`evaluate.ts:152`); the
  sensitive-file false-positive rescue overrides a bogus deny AND refreshes
  the scope so the quarantine doesn't cascade (`evaluate.ts:127`). A
  `PackDecision` is a stateless verdict; it has no channel for "retry after
  mutating kernel state".
- **Quarantine semantics leak across calls.** The tainted-shell pre-gate
  (`enforce-policy.ts:86`) denies BEFORE `ariEvaluate` precisely so the kernel
  never observes a taint+shell event and quarantines the rest of the op. And a
  kernel deny of an egress-class tool doesn't terminate with one reason — it
  is aggregated with the downstream egress blockers via `egressAggregateGate`
  (`enforce-policy.ts:102`), which the evaluator's short-circuit-on-first-deny
  (`evaluator.ts:125`) cannot express.

## Decision

The ARI kernel gate stays its own seam, invoked from the policy phase ahead of
pre-dispatch. Do not fold it into the RulePack evaluator — doing so would
subordinate its ordering and fail-closed guarantees to the pack contract
(sealed rule list, stateless verdict, first-deny short-circuit) for zero
behavioral win.

The no-op placeholder `src/tool-policy/packs/arikernel-pack.ts` is deleted in
a sibling change; the pack id existed only to make the F4 unification's
coverage of the arikernel policy surface explicit, and the default-policy pack
already carries the same deny-by-default posture.

## Consequences

- Future architecture reviews should not re-flag "the kernel is not in the
  RulePack seam" as a gap. Its position outside the seam is the mechanism, not
  an oversight.
- The RulePack seam remains the home for policy-shaped vetoes — spend cap,
  security layer, threat engine, egress refutation, and the default-policy
  backstop: stateless per-call verdicts with no cross-call state.
- A future genuine unification would need to preserve kernel-first ordering,
  the fail-closed contracts, the scope-refresh/retry loop, and the egress
  aggregate explicitly — i.e., extend the evaluator's contract, not squeeze
  the kernel into the current one.
