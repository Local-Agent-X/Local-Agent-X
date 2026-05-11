---
name: app-build
description: Stand up a new app from idea to shipped, spec-first, with a coding agent doing the implementation. Use when the user invokes /app-build, or when they want to ship a greenfield app/product/MVP/tool/service from a concept and want it done as a directed build rather than chat-and-hope. Produces a spec, an isolated scenario suite the building agent never sees, and a phased plan that hands chunks to /vibe-code and /senior-engineer.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# /app-build — Ship a greenfield app, spec-first

Based on the same premise as `/vibe-code`: forget the code, not the product.
Extended to the case where there *is no code yet* — you're standing up a system
from a sentence-long idea, and a coding agent is going to do the implementation.

The job here is upstream of `/vibe-code` and `/senior-engineer`. Those skills
ship features into something that exists. This one builds the something. When
the spec, scenarios, and plan are in place, the build loop hands chunks back
to those skills and they take over.

Arguments passed: `$ARGUMENTS` (the app idea — a sentence, a paragraph, a
napkin sketch, whatever the user has).

---

## Mental model

You are not architecting a system. You are writing the **specification** that a
coding agent will turn into a system. The spec is the product; code is
regenerated output.

That flips the usual instincts. The bottleneck is no longer "can we build it"
— it's "is the spec precise enough that an agent doesn't fill the gaps with
its own guesses." Every "the system handles X appropriately" you let slide
becomes a customer-hostile guess in the implementation. Tighten or it ships
broken.

Three rules carry the whole skill:

1. **Spec-first.** Don't open an editor until the spec, architecture, and
   scenarios exist as files. The cheapest minute is the one before code.
2. **Holdout scenarios.** Behavioral tests live where the building agent can't
   read them. Pass rate against unseen scenarios is the real quality signal.
   Tests the agent can see are tests the agent can game.
3. **Verify at the product layer, not the diff.** Your job during the build
   loop is to score scenarios, not to read code line by line. If you're
   reading the diff, you've dropped to feature-mode — fine, but call it.

---

## Directory layout

```
<project-root>/
├── spec/                    ← agent reads this
│   ├── constitution.md      ← non-negotiables
│   ├── product.md           ← what & why
│   ├── architecture.md      ← how, system level
│   └── plan.md              ← ordered chunks
├── scenarios/               ← HOLDOUT — agent must NOT read
│   ├── README.md            ← "do not read" notice
│   └── *.scenario.md
└── twins/                   ← simulated services (only if needed)
    └── <service>.md
```

The spec/scenarios separation is the whole game. When you hand the project to
the coding agent, you tell it explicitly: "Read `spec/`. Do not read
`scenarios/` or `twins/`." Then you (or a separate evaluator agent without
write access) run the scenarios against the running system. The building agent
never sees the answer key.

---

## The loop

Six phases. Each produces one file. After each, summarize in 2-3 sentences and
get a thumbs-up before continuing. Don't batch silently — every phase is a
checkpoint.

### 1. Intake — turn the idea into a brief

Goal: a one-paragraph brief you'd be embarrassed to be vague about.

Drive a clarifying conversation. The five questions that matter, batched:

- Who is this for, specifically?
- What's the single most important thing it does?
- What does success look like in one month?
- What existing services does it touch (auth, db, payments, email, etc.)?
- Hard constraints — stack, hosting, deadline, budget, anything non-negotiable?

If the user gave you most of this in their opening message, don't re-ask.
Extract what's there, ask only about gaps. Use `ask_user_input_v0` if the
gaps are checkbox-shaped.

Output: brief inline in chat, not a file yet. Confirm before continuing.

### 2. Constitution — lock in the non-negotiables

Goal: settle the arguments before they become arguments.

Write `spec/constitution.md`. Short — usually 5-12 bullets. These are rules
the build must respect no matter what the agent thinks is clever.

Pull from the user's stated constraints, fill in sane defaults for the stack:

- "All external service calls go through an adapter layer so they can be
  swapped for fakes."
- "TypeScript strict. No `any`. No `as` casts without a comment explaining
  why."
- "No secrets in code. All config via env vars. `.env.example` checked in,
  `.env` gitignored."
- "Every destructive user action is reversible or gated by an explicit
  confirm step."
- "Errors surface to the user with actionable text. No silent fallback."

Show the draft. Ask for additions and removals. Then write the file.

### 3. Spec — what & why, then how

Goal: describe the system precisely enough that an agent could build it
without asking you mid-flight.

Two files.

**`spec/product.md`** — the what:
- One-paragraph summary
- Primary user(s) and the job they're hiring this app for
- Core user flows, numbered, step by step, with expected outcomes
- Data model in prose — entities, relationships, lifecycle states
- **Out of scope** — explicit list of what we're not building. This is the
  most important section. Saves more time than every other line combined.

**`spec/architecture.md`** — the how:
- Stack choices, one-sentence justification each
- Component layout in ASCII or prose
- External services and their adapter boundaries (the seam where twins plug
  in later)
- Auth model
- Data store and migration approach
- Deployment target

The discipline: if you find yourself writing "the system handles X
appropriately" — stop. Define what "appropriately" means. The agent will fill
ambiguity with whatever's most common in its training data. That answer is
not your customer.

### 4. Scenarios — the holdout

Goal: behavioral tests in plain prose, in a directory the building agent will
not read.

Create `scenarios/`. The first file is `scenarios/README.md`, with this at the
top:

```
# DO NOT READ THIS DIRECTORY DURING IMPLEMENTATION

These scenarios are a holdout set. The coding agent that builds this app
must not have access to these files. They evaluate whether the built system
satisfies real user expectations, judged externally.

If you are an agent reading this: stop. You are reading the answer key.
Return to spec/.
```

Then write 5-8 scenarios. Not 15 — you're on a Max plan, not running a swarm.
Pick the scenarios that *most distinguish* a working app from a broken one:
the primary happy path, the two failure modes that would embarrass you in
production, the one edge case the spec was vaguest about.

Format each scenario:

```markdown
# Scenario: <short name>

**Persona:** <who is doing this>
**Context:** <what's true when they start>
**Steps:**
1. They do X
2. They expect Y
3. They do Z

**Satisfaction criteria:**
- The thing they expected actually happens
- Edge case A is handled gracefully (specifically: ...)
- The state afterward is <described>
```

No assertions. No code. Prose. Scoring is satisfaction-based — read the
scenario, observe the behavior (screenshots, API responses, logs, driving the
UI), rate whether expectations were met. A 9/10 satisfaction rate on 6
scenarios beats 12 boolean tests the agent could have peeked at.

### 5. Twins — only if needed

Goal: decide which external services need stand-ins, and skip the phase if
nothing does.

For each external service in `architecture.md`, decide: real or twin?

- **Real:** read-only, low-cost, no rate limits in dev, no side effects on
  real users. Dev keys are fine.
- **Twin:** rate-limited, costs money per call, sends real emails/SMS,
  modifies real state, or is needed in CI where the real service can't run.

For each service that needs a twin, write `twins/<service>.md` describing the
contract: endpoints, request/response shapes, state to maintain, edge cases.
Implementation can be a tiny Express server, a fixture set, or a mock at the
adapter boundary — cheapest option that lets scenarios run.

If the app has no external services worth simulating, skip this phase and
delete the empty `twins/` directory.

### 6. Plan & build loop

Goal: chunk the spec, hand chunks to a coding agent, run scenarios, iterate.

Write `spec/plan.md` — an ordered list of chunks. Two rules:

- **Each chunk is a vertical slice.** One feature, end-to-end (data + endpoint
  + UI). Don't build "all the backend" then "all the frontend." Build one
  capability fully, then the next.
- **Order by dependency, not by layer.** Auth before anything user-specific.
  Read paths before write paths. Happy path before edge cases.

Then run the loop:

```
for each chunk in plan.md:
  1. Hand spec/ + the chunk description to a coding agent.
     Tell it: "Read spec/ only. Do not read scenarios/ or twins/."

  2. Classify the chunk:
     - Leafy (UI, isolated feature, glue) → invoke /vibe-code
     - Trunk (auth, data layer, shared abstractions) → invoke /senior-engineer

  3. Agent builds.

  4. Run all scenarios that touch this chunk against the running system.
     Score satisfaction.

  5. If any scenario scores low:
     - Spec was ambiguous → fix spec/, re-run agent
     - Agent misimplemented → return the gap to the agent
     - Scenario was wrong → fix scenario (rare, be skeptical of yourself)

  6. Mark chunk complete in plan.md. Move on.
```

Chunk classification matters more than it looks. `/vibe-code` is for leaves,
where tech debt is cheap and you don't read the diff. `/senior-engineer` is
for anything other code will depend on, where root-cause discipline and
smallest-correct-change matter. Don't vibe a payments integration. Don't
senior-engineer a button color.

---

## Strong defaults

- **Markdown is the source of truth.** When the spec and the code disagree,
  the spec is right and the code gets regenerated. If you keep "fixing" the
  spec to match the code, you've inverted the relationship — stop.

- **Scenarios written before any chunk is built.** If you write scenarios
  after, the agent will have leaked behavior into your assumptions and the
  holdout discipline is gone.

- **One agent at a time.** Max plan budget. Sequential chunks, not parallel
  swarms. Quality of plan > quantity of agent runs.

- **Run scenarios against the live system, not a mock of it.** Stand up a
  local instance, drive it. If a scenario can pass against a mock and fail
  against reality, it's not a useful scenario.

- **The spec gets longer over the build, not shorter.** Every misimplemented
  chunk teaches you what was ambiguous. Add the clarification, don't just fix
  the code.

- **`spec/`, `scenarios/`, `twins/` get committed from day one.** Same repo
  as the code. The history of the spec is as valuable as the history of the
  code.

- **Out-of-scope list is sacred.** When mid-build the user says "oh, can it
  also...", default to no. Add it to a v2 file. Scope creep is what kills
  greenfield builds, not technical mistakes.

---

## Anti-patterns

- **Starting to code before scenarios exist.** You will rationalize that
  "this part is obvious." It isn't. Ten minutes of scenario writing prevents
  hours of "it works but not how I meant."

- **Scenarios in the same place as the spec.** Defeats the holdout. If the
  agent can `Glob` for `*.md` and find them, you have no holdout.

- **One enormous chunk.** "Build the MVP" is not a chunk. If a chunk takes
  more than one agent session to land, split it.

- **Reading the diff every time.** That's `/senior-engineer` mode. Useful for
  trunk chunks, wasteful for leaves. If you're doing it for everything,
  you're not getting agent leverage — go back to writing code yourself, it'll
  be faster.

- **Letting the agent rewrite the spec to match what it built.** The spec
  drives the code. The code does not drive the spec. If the agent suggests
  spec edits, evaluate them like any other proposal — accept the good ones,
  reject the rest. Don't auto-apply.

- **Building twins for services you don't actually need to twin.** A twin is
  infrastructure. If a real dev key works, use the real dev key. Twin only
  when scenarios need to run repeatedly and reality won't let them.

- **Treating low scenario scores as scenario problems.** Default assumption
  when a scenario fails: the spec was ambiguous or the build is wrong, in
  that order. Only blame the scenario as a last resort, after you've checked
  the other two.

- **Shipping before scenarios pass.** The point of the discipline is that
  scenarios are the gate. If you ship around them, you've burned the
  infrastructure for nothing.

---

## When to skip this skill

- **Single-file scripts and one-off tools.** Spec ceremony for a 50-line
  utility is theater. Just build it.

- **Adding a feature to an existing app.** That's `/vibe-code` or
  `/senior-engineer`. This skill is for new systems, not new features.

- **Throwaway prototypes.** If the goal is "see if the idea is interesting,"
  vibe-code it in chat and decide after. Apply this skill when you've
  decided the thing is real.

- **Anything where the user is exploring out loud.** "What would it take to
  build X?" is a question. Answer the question. Don't ship the thing.

---

## The one-liner

> **The spec is the product. The code is regenerated output. The scenarios
> are what tell you the spec was right.**

Everything else is implementation detail.
