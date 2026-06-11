---
name: vibe-code
description: Apply the "vibe code in prod responsibly" methodology — act as PM for the model on a non-trivial feature, target leaf nodes, design for verifiability without reading every line. Use when the user invokes /vibe-code, or when they ask you to ship a larger AI-driven feature and want it done responsibly rather than as a quick chat back-and-forth.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# /vibe-code — Ship a feature responsibly with AI

Based on Eric Schluntz's talk *How to vibe code in prod responsibly*. The premise:
true vibe coding means forgetting the code exists. That's fine for toys, dangerous
for prod. The way to do it safely is to **forget the code, not the product** —
behave like a senior PM managing an expert whose implementation you won't read.

This skill turns that principle into a concrete workflow. Invoke it when you're
about to spin up a non-trivial feature you'd otherwise just chat your way through.

Arguments passed: `$ARGUMENTS` (a feature description, bug, or initiative).

---

## The mental model

You are not a coder hitting tab-complete. You are a PM for an expert engineer.
A PM doesn't read every line their team writes — they ensure:

1. The requirements are clear and the engineer has the context to succeed.
2. The work happens in a place where bugs are contained.
3. The output is verifiable without reading the implementation.

Your job in this skill is to set up all three of those things before letting
the model cook, then verify at the abstraction layer instead of the line layer.

> Caveat: tech debt is the one thing you cannot validate without reading the
> code. So vibe-code work belongs in **leaf nodes** — code nothing else
> depends on. Trunks and branches still get human review.

---

## Workflow

### 1. Frame the work (don't skip)

Before writing any code, produce a written plan. Spend ~15-20 min on this — it
is the highest-leverage time in the whole feature.

Drive a planning conversation that produces a single artifact covering:

- **Goal** — one paragraph. What does done look like for the user?
- **Requirements & constraints** — bullets. Edge cases, perf budgets, security
  surface, what must not break.
- **Files to touch** — explore the codebase first (Glob/Grep). List them.
- **Patterns to follow** — name a similar feature already in the repo to
  mirror. "Look at how X does Y."
- **Leaf vs trunk classification** — which parts of this change are leaves
  (safe to vibe) and which are trunk (need careful human review)?
- **Verification plan** — what tests or stress runs prove this works without
  the user reading the diff? (See section 3.)
- **Out of scope** — what we're explicitly not doing. Prevents drift.

If the user already gave you most of this in the prompt, just confirm the gaps
and proceed. Don't bureaucratize a 10-line change.

### 2. Place the change in a leaf node

Before editing, sanity-check: is what we're about to vibe-write a leaf or a
trunk?

- **Leaf** — UI bells/whistles, isolated commands, one-off scripts, end
  features that nothing imports. Tech debt here is cheap. Vibe freely.
- **Trunk** — base abstractions, shared services, anything other code imports
  from. Tech debt here metastasizes. Slow down, read the diff, treat the model
  as a drafter not an author.

If the requested feature lives in a trunk, surface that to the user and offer
two paths:
1. Tighten scope so the trunk change is small and human-reviewed, with the
   leafy parts (UI, glue) generated more freely.
2. Restructure so the new code goes in a new leaf module instead of mutating a
   trunk.

Only proceed deep-vibe-mode if the work is genuinely leafy.

**Mixed work — the most common real case.** Most non-trivial vibe-code tasks
are not pure leaf. The UI is leaf; the server action it calls is leaf; but
the new domain function that action invokes — the one in `lib/scheduling/`,
`lib/booking/`, `lib/calendar/`, or any shared module — is trunk. Other code
will import it. That makes the chunk **mixed**, not leaf, even if the bulk
of the diff is UI.

**Trunk-detection heuristics for vibe-code work:**
- Any new exported function in a shared library directory (`lib/<domain>/`,
  `src/<domain>/`, `internal/<domain>/`, etc. — match the project's
  convention) is trunk. Other code, including future chunks, will depend on it.
- Any new optional argument added to an existing exported domain function is
  trunk-shaped — it's a contract change. The new branch gets a test.
- A new database write path (insert, update, delete in a shared repository
  module) is trunk. Concurrency / ownership / status-flip semantics belong
  in tests, not "we'll see in scenario runs."
- A new server action in a Next.js / similar framework counts as leaf only
  if it's a thin call into existing trunk; if it implements business logic
  inline, the inline logic is trunk.

**When a vibe-code task contains trunk pieces, do NOT skip tests on those
pieces.** "It's a leaf chunk overall" is not a license to ship untested
domain code. Treat the trunk pieces with senior-engineer discipline:
- Read the surrounding module to match conventions.
- Write unit tests covering the happy path + each guarded branch (ownership,
  status, race, etc.) before declaring done.
- Mirror the test conventions of nearby existing tests, don't invent.
- The leaf pieces (UI, layout, button glue) can still be verified by scenario
  runs in the usual vibe-code way.

If the chunk handed to you is classified pure-leaf in the plan but you
discover a trunk piece during step 2, surface it. Don't silently widen the
chunk; either tighten the scope or note the mixed nature in your output so
the plan can be sharpened.

### 3. Design the verifiability layer first

Before implementation, design how you'll prove correctness without reading the
implementation. Pick from:

- **Acceptance tests** — 3 endtoend tests. Happy path + 2 specific failure
  modes. Keep them general, not implementation-specific. The user reads these,
  not the implementation.
- **Stress tests** — for stability-sensitive code, design a long-running
  driver that exercises the system. Pass = stable for N iterations.
- **In/out checkpoints** — design the interface so inputs and outputs are
  trivially human-verifiable (e.g. a CLI takes a JSON in, prints a JSON out;
  user reads two JSONs instead of the engine in between).
- **Manual product check** — for UI: open it in a browser, drive the golden
  path, drive 2 edge cases. Verify regressions in adjacent features.

Write these *first*, with the user, before generating the implementation. They
become the contract.

### 4. Cook

Now generate the implementation. You can move fast here — the safety nets are
already in place. Compact / start fresh sessions at natural stopping points
(plan finalized, scaffolding done, feature complete) so the context stays clean.

### 5. Verify at the abstraction layer

Run the verifiability layer from step 3. Don't claim done until:

- All acceptance tests pass.
- Stress tests (if applicable) ran for the agreed duration with no failures.
- For UI work: you opened it in a browser and drove the flows. If you can't
  drive the UI yourself, say so explicitly — type-checking and tests verify
  code correctness, not feature correctness.
- The user-facing summary describes what changed at the product level, not the
  code level.

### 6. Read the trunk parts only

If any part of the change touched a trunk node, read that diff yourself before
declaring done. Vibe is for leaves; trunks get eyeballs.

---

## Heuristics from the talk

- **Ask not what the model can do for you, but what you can do for the
  model.** Most failures upstream of bad code are failures to give context.
- **Don't over-constrain.** Models do best with goal + relevant patterns, not
  rigid templates. Don't invent a PRD format.
- **Tests as the contract.** When vibe coding, often the *only* code you read
  is the tests. So tests must be end-to-end and minimal — not implementation
  shadows.
- **Compact at human-shaped boundaries.** Compact when a real engineer would
  stop for lunch — after a plan is written, after a feature lands. Not mid-edit.
- **Embrace the exponential.** Today's hour-long task is next year's day-long
  task. Build the muscle of verifying-without-reading now; you'll need it more
  every quarter.

---

## Anti-patterns to refuse

- **Vibe-coding auth, payments, secrets handling, or anything that touches
  user data without explicit security framing.** The press disasters
  ("leaked API keys", "bypassed subscription") all came from people vibe-coding
  surface area they didn't understand. If the user asks for one of these,
  treat the security model as a trunk concern: design it carefully, read the
  diff, don't hand-wave.
- **"Just YOLO it across the whole codebase."** Vibe is for leaves. If the
  blast radius is the whole repo, slow down.
- **Skipping the verification layer because "tests pass."** Tests passing
  proves the tests pass. Verifiability is a separate design step — it's about
  the user being able to trust the change, not the model being able to.
- **Generating tests after the implementation, then trusting them.** The
  model will write tests that match whatever it just wrote. If you didn't
  agree on the tests up front, they're not a contract — they're a mirror.

---

## When to skip this skill

- Single-file edits, one-line fixes, refactors you're going to read anyway —
  just do them.
- Exploratory chat where the user is thinking out loud. Don't ceremonially
  apply this on a "what do you think about X?" question.
- Anything where the user is in tight feedback loop mode (cursor-style,
  reviewing each change). That's not vibe coding; that's pair programming. Use
  normal workflow.
