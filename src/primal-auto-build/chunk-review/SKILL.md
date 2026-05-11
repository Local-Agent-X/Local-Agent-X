---
name: chunk-review
description: Evaluate a just-completed build chunk against its done-when, classify spec drift, decide whether to proceed/amend/push-back/halt. Tool-only — invoked by the primal_run_build_plan loop, not by users directly.
user-invocable: false
---

# /chunk-review

Internal skill invoked by `primal_run_build_plan` after each chunk subprocess returns. Its single job is to decide one of four actions:

- **proceed** — chunk shipped clean; commit + advance
- **amend_spec** — chunk surfaced a missing constraint the spec should encode; apply an **additive** spec edit, commit it separately, advance
- **push_back** — chunk's done-when isn't met but the gap is mechanical; respawn the same chunk subprocess once with the reviewer's reasoning appended
- **halt** — surface to the user; auto-recovery is unsafe

## The five gate checks

The discipline this skill encodes was distilled from the Calenbella manual build (May 2026), where I (the reviewer) repeatedly caught silent deferrals, Constitution gray areas, and missing implicit constraints. The gates are mechanical because mechanical is auditable; LLM judgment can layer on top for fuzzy cases.

### 1. Report-shape gate

The subprocess prompt mandates an exact STATUS / DONE_WHEN / CHANGED / TESTS / NEW_FAILURES / PRE_EXISTING_FAILURES / SPEC_GAPS / LAUNCH_READINESS / NOTE block at the end of its reply. If the report doesn't parse to that shape, **halt** — the subprocess either timed out mid-report or freelanced its output. Either way, don't commit.

### 2. Done-when verifier

Confirm the agent actually met the chunk's done-when. Failure shapes that halt:

- `STATUS != done` — chunk explicitly didn't ship
- `DONE_WHEN: unmet | unknown` — agent admits it didn't meet the contract
- `DONE_WHEN: deferred-to-launch-readiness` **when the plan's done-when names a mechanical verification** (integration test, unit test, asserts X) — the chunk-6 silent-deferral pattern: agent reframes a chunk-local correctness contract as a launch-time concern. Halt.
- `DONE_WHEN: met` but the NOTE prose contains a contradictory phrase ("deferred to launch-readiness", "didn't run the test", "wasn't able to run", "skipped"). The structured field is too optimistic; the prose tells the truth. Halt.

### 3. Additive-diff check — **most important**

Spec amendments proposed by the review pass (or by the loop in response to a review finding) must **never** weaken constraints. The reviewer parses any `git diff -- spec/` since the chunk's pre-state and classifies each removed line as:

- **Replaced-with-stricter-equivalent** — a nearby addition restates the constraint more strictly (contains "must", "required", "always", "forbidden", ≥/≤, "fails when", "enforces", or reads as a near-superset of the removed text). Acceptable.
- **Weakened** — no stricter replacement. **Halt.** Surface the offending line to the user.

False positives on this gate are recoverable (the user authorizes). False negatives (silently weakening spec to match buggy code) are not — that's the entire failure mode this gate exists to prevent.

### 4. Phase-gate detector

If the just-completed chunk is the **last in its phase** AND the plan's "Phase verification gates" section references that phase by short label (e.g. "Phase D"), halt with a "drive scenarios at $URL, score satisfaction, then resume" message. Don't try to score scenarios autonomously — that's a human task.

### 5. Launch-readiness emitter

Launch-readiness items are valid and expected. They don't halt **unless** the item lacks a concrete verify step. Each item must name how to verify it before launch — "set X env, run Y test, assert Z" — not just "test in staging." Vague items halt with a request to sharpen.

Concrete items get appended to `LAUNCH_READINESS.md` by the loop (chunk 7 of the tool build). The review skill itself just enforces the concreteness contract.

### 6. Test-failure escalation

- `NEW_FAILURES` non-empty → halt; name the failing tests. New regressions are not allowed to commit.
- `PRE_EXISTING_FAILURES` only → not a halt; the loop logs a punch-list item.

### 7. Spec-gap judgment (auxiliary)

Catches the chunk-10 pattern (agent surfaces a Constitution gray area as "two options, you decide") and constitution-tagged ambiguity. If the NOTE body:

- Surfaces a fork ("two options", "your call", "user decides") — halt; auto-deciding violates the discipline.
- References a Constitution rule + leaves it as a gray area / silent fallback / theoretical concern — halt; resolve it (fix code or amend spec) before proceeding.

The chunk-12 pattern (agent doesn't surface a gap, but the reviewer recognizes an implicit-spec violation by reading the constitution and slice) is harder — it requires LLM judgment over the chunk's CHANGED files and the spec's constitution. The loop can wire an external judgment hook here when one is available; the mechanical gate by itself doesn't catch chunk-12.

## Priority order

When multiple gates fire, the strongest action wins: **halt > push_back > amend_spec > proceed**.

## What this skill explicitly does NOT do

- Decide whether to retry a halt automatically — that's the loop's failure-recovery harness (chunk 9).
- Apply spec edits — the loop applies edits after the review returns `amend_spec` with a `specDiff`.
- Run git commands — the loop owns git state; the review is a pure function over `(chunk, plan, rawReport, specDiff)`.
- Score scenarios — humans score scenarios; phase-gate halts surface the scenario list and stop.

## Fixtures the gate logic is tested against

From the Calenbella build (`~/.claude/projects/c--Users-manri-Calenbella/*.jsonl`):

- **chunk-6** — silent Google-integration deferral → expects `halt`
- **chunk-10** — Constitution #8 gray area surfaced as "two options" → expects `halt`
- **chunk-12** — missing stale-data warning (additive-only spec amendment) → expects `amend_spec` (requires LLM judgment hook or pre-supplied SPEC_GAPS)
- **clean-proceed** — synthetic clean ship → expects `proceed`

These live under `test/fixtures/primal-chunk-review/`.
