---
name: chunk-review
description: Review a just-built chunk and decide proceed / amend_spec / push_back / halt. Internal to the build engine; not invoked by users.
user-invocable: false
---

# /chunk-review

What the build loop runs after each chunk's worker returns. It decides one of four actions:

- **proceed** — the chunk lands; commit and advance.
- **amend_spec** — the chunk surfaced a constraint the spec should state; apply an **additive** spec edit, commit it apart, advance.
- **push_back** — the work is not finished or does not hold; it goes to the build's lead (or the push-back advisor when the build has none), who sends it back to a worker, lands it with a check owed, or parks it for the owner.
- **halt** — stop the build; auto-recovery is unsafe.

## The rule

**Code acts only on what it measured or on a typed field. Nothing parses prose a model wrote.**

The worker, the skeptic and the break-it agents each end their run by calling a report tool (`agents/report-tools.ts`: `chunk_report`, `skeptic_verdict`, `breaker_findings`). The tool checks the arguments when it is called, so the model can correct them. An agent that ends without calling its tool has not reported; that is never read as a failure of the work.

Until 2026-11-26 the reports were text blocks read with regexes, and every phrasing a model reached for was a new bug: `NEW_FAILURES: none observed` read as a failing test, a skeptic's answer with no `VERDICT` line read as BROKEN, a launch-readiness item held a chunk for sounding vague.

## What the worker's report decides

Only its own typed word that it stopped (`gate-done-when.ts`): `status` blocked or partial, or `done_when` unmet. That is a claim, so it goes to whoever judges claims (the lead, or the advisor). Never a halt from the gate.

- `machine_blocked` beside a stopped status takes the road of a refusal the build check saw itself (`build-refused`): the lead decides owed or park; no worker is sent to fix a machine.
- `machine_blocked` or `owner_question` beside a finished status does not hold the chunk: it lands, and the item goes on the owner's ledger of owed checks.
- A worker that made **no report** is not sent back for it. Its work goes straight to the measured checks.
- The files a chunk changed are read from git, never taken from the report.

How a note is worded decides nothing. Whether the done-when is met is what the held-out scenarios and the skeptic judge.

## The checks, in order

1. **The worker's own word that it stopped** (above).
2. **Additive-diff check — the most important.** A `git diff -- spec/` since the chunk started must never weaken a constraint. Each removed line is either *replaced by a stricter equivalent* nearby (acceptable) or *weakened* (halt, naming the line). A false positive is recoverable; silently weakening the spec to match buggy code is not.
3. **Phase-gate detector.** The last chunk of a phase the plan's "Phase verification gates" section names pauses at that gate after it is accepted. The chunk is still built, tested and judged like any other.
4. **Build check** (`gate-build-exec.ts`). Runs the project's real build and tests and reads exit codes, then loads a static entry headless. Three results: passed, failed (the only one that reaches a worker), and could not run on this machine (owed to the owner, never a fix round). A command that ran and failed with a machine refusal in its output is `build-refused` and goes to the lead.
5. **Chunk judge** (`chunk-judge.ts`). The chunk's held-out scenarios, and a skeptic that tries to break the change against its contract. A skeptic that gave no verdict is asked once more, then owed.
6. **Spec-gap judgment hook** (`judgment-hook.ts`). A model reads the changed files against the constitution and can raise proceed to amend_spec. It never lowers a verdict.

Checks 4 to 6 run only when 1 to 3 let the chunk through. When a review sends a chunk back before its judge ran, the outcome says so (`chunk-unjudged`), and the lead can land that work only with the judging owed or the stopping check overruled.

## Priority

When several checks fire, the strongest wins: **halt > push_back > amend_spec > proceed**.

## What this module does not do

- Decide what happens to a pushed-back chunk: `loop/handle-push-back.ts` and the lead.
- Apply spec edits or run git: the loop owns git state.
- Keep the ledger of owed checks: `failure-recovery.ts`. The review only lists what it could not check on its outcome.

## Tests

`test/auto-build-chunk-review.test.ts` (the review's own checks on typed reports), `chunk-judge.test.ts`, `skeptic.test.ts`, `test/auto-build-machine-refusals.test.ts` (every check site against captured refusals).
