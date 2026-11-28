---
name: greenfield
description: Start a new project and take it from a one-line idea to a working, verified app in one flow. Interviews the owner into a precise spec (stated constraints, look and feel), writes a held-out scenario suite the building agents cannot read (sealed by LAX itself, not by a request), sets up the repo's rules, map and build checks, then builds in chunks either SUPERVISED (the owner reviews each phase and chunk) or AUTONOMOUS (one approval, then parallel and hands-off for hours), and reports done only after the whole suite, break-it agents, a code-quality sweep, a security review and an owner walkthrough. Use when the user invokes /greenfield, says "start a new project", "new app", "build me an app / MVP / tool / service", "build this from scratch", "stand up a new repo and build X", "build it autonomously", "run it for hours without me", or has an idea and no code yet. Includes the new-repo half of /new-project. Not for changing an existing codebase (/brownfield) or bringing an existing repo up to standard (/new-project, retrofit mode).
user-invocable: true
allowed-tools:
  - read
  - write
  - edit
  - glob
  - grep
  - bash
  - agent_spawn
  - ask_user
---

# /greenfield — From an idea to a verified app, supervised or autonomous

Arguments passed: `$ARGUMENTS` (the idea: a sentence, a paragraph, a sketch).

An agent can write the code. What it cannot do is know what the owner meant,
check its own work honestly, or leave the owner understanding what they now
own. This skill is the structure around the agent that covers those three:

- **The spec is the product; code is regenerated output.** The owner and the
  agent write a spec precise enough that the agent has nothing left to guess.
  When the spec and the code disagree, the code changes.
- **The builders never see the test.** Acceptance scenarios are written first,
  kept outside the repo and sealed by LAX itself. A separate judge scores the
  running app against them. Passing a test you could not read means something.
- **The repo tells agents the truth.** Rules, an ownership map and build checks
  go in before the first feature, so a duplicate, an oversized file or a stale
  doc fails the build instead of waiting for a review.
- **Green is not done.** After the scenarios pass, other agents try to break
  the app, the code is checked for quality and security, and the owner is
  walked through what was built.

## What stays with the owner

Decide the engineering and move on. Never decide these; ask at the interview,
or park them and route around:

- **Product:** what it does, what is in scope, what "done" means.
- **Taste:** how it looks, reads and feels.
- **Money and risk:** anything that costs, bills, or handles data in a way
  someone could object to.
- **Shipping:** deploy, publish, push. The skill never does these.

## Pick the mode

Ask once if the owner has not said. Both modes share phases 1-6 and 8-9; they
differ only in how the chunks are built.

| | Supervised | Autonomous |
|---|---|---|
| For | small apps, or an owner who wants to watch | larger builds, or an owner who wants to walk away |
| Owner approves | each phase, and each chunk as it lands | once, after the plan |
| Chunks run | one at a time | in parallel worktrees, scheduled by files touched |
| A product or taste question | is asked on the spot | is parked; the run continues around it |
| Each chunk is judged by | the judge, then the owner | the judge and a skeptic agent |
| `spec/ledger.md` holds | the scenario index and each chunk's status | those, plus the graph, every decision made and every question parked; the run relies on nothing else |

The owner can switch at any chunk boundary: "take it from here" moves a
supervised build to autonomous (write the ledger first), and an autonomous run
that parks too much is a sign to drop back.

## Layout

```
<project>/
├── spec/
│   ├── constitution.md   non-negotiables
│   ├── product.md        what and why, done-list, out of scope
│   ├── architecture.md   how, at system level
│   ├── design.md         look and feel (when there is an interface)
│   ├── plan.md           ordered chunks with footprints
│   └── ledger.md         scenario index, status, decisions, parked questions
├── twins/                stand-ins for external services (only if needed)
├── AGENTS.md  ARCHITECTURE.md  docs/   rules, ownership, generated map, ADRs
├── scripts/              the structure checks
└── .lax-launch.json      how the judge starts the app

the sealed scenario suite: kept by LAX outside the project (holdout_write)
```

## The flow

Nine phases. In supervised mode, summarize each in two or three sentences and
get a yes before the next. In autonomous mode, phases 1-5 are done with the
owner, then one approval covers everything after.

### 1. Interview

Turn the idea into a brief you would be embarrassed to be vague about: who it
is for, the one thing it must do, what success looks like, what it touches, the
constraints an agent would otherwise guess (identity keys, data, money), and
the look and feel. Ask only about gaps, offer a recommended answer with each
question, and keep going until the owner's reaction to the finished app could
not surprise you. Questions and the reasoning: `references/spec.md`, section 1.

Output: a one-paragraph brief, inline. Confirm it before writing any file.

### 2. Constitution

The project folder is the one this chat works in, when it has one (a code
session opened on a folder): build there, whatever its name. A chat with no
folder creates `workspace/apps/<name>`, the name in letters, digits, `-` and
`_`, so a web app is served at `/apps/<name>/` and opens on the phone. Never
move a project out of the folder the owner opened, or delete work to start
over; if that folder cannot do what the app needs, say why and ask. `git init`
it, so `spec/` has history from its first file. Then `spec/constitution.md`: 5-12 rules the build respects no
matter what an agent thinks is clever, drawn from the owner's "never" answers
plus sane defaults for the stack. Every chunk brief carries them.
`references/spec.md`, section 2.

### 3. Spec

`spec/product.md` (the what, with a checkable **done-list** and an explicit
**out of scope**), `spec/architecture.md` (the how), `spec/design.md` (the look
and feel), the **tier** it will run at, and a twin for any external service a
development key cannot stand in for. `references/spec.md`, sections 3-7.

Wherever you would write "handles X appropriately", say what appropriately
means. That sentence is where the agent's guess goes.

### 4. Scenarios, then seal

Write the acceptance scenarios from the spec, in plain prose, one
`holdout_write` call each. Show them to the owner. Record the index (file names
and what each covers, nothing more) in `spec/ledger.md`. Then seal the suite
with `holdout_seal`, and prove the wall by having a throwaway agent try to read
the suite and be refused.

Do this before any chunk is planned in detail or built. Written afterwards,
scenarios describe what was built instead of what was wanted.

The seal is live the moment `holdout_seal` returns; no new session is needed.
If the probe is not refused, stop and tell the owner: the wall is broken.

Formats, the sealing steps and the probes: `references/holdout.md`.

### 5. Plan

`spec/plan.md`: the foundation first, then vertical slices ordered by
dependency. Each chunk records its kind (`trunk` or `leaf`), what it covers,
its **footprint** (the files it creates or edits), what it depends on, and
which scenarios verify it. `references/spec.md`, section 8.

**Autonomous mode: this is the one approval.** Present the restatement and
done-list, the spec, the scenario index, the tier, the plan and its graph, what
is not being built, and the wall probes' outcome. Wait for a yes.
`references/autonomous.md`, section 1.

### 6. Foundation

One owner, serial, in both modes: create the repo, add the structure kit (`project_kit`),
wire its checks into the build, write `AGENTS.md` and `ARCHITECTURE.md`, build
the skeleton that every feature will plug into, give each coupling its test,
and prove each gate fails on a real violation. `references/structure.md`.

Nothing runs in parallel before this lands. The skeleton creates the seams, and
two agents scaffolding at once produce two apps.

### 7. Build the chunks

**Supervised.** For each chunk in `spec/plan.md`:

1. Build the chunk with `run_build_plan` (`starting_chunk` set to it,
   `max_chunks: 1`). The engine hands a builder the chunk and `spec/` in its
   own worktree; it builds from `spec/` only.
2. The chunk's Class sets the discipline. A `trunk` chunk (auth, the data
   layer, anything other code depends on) is built under `/senior-engineer`:
   root cause, smallest correct change, and you read the diff. A `leaf` chunk
   (a screen, an isolated feature, glue) under `/vibe-code`: verify by
   behavior, do not read every line. Do not vibe a payments integration; do
   not senior-engineer a button color.
3. Run `check`. The engine has already scored the chunk's **Scenarios:**
   and set a skeptic agent on its diff; the run summary shows each score and
   the skeptic's verdict. A chunk that names no scenario is not scored: judge
   it with `holdout_judge`.
4. On a failure, assume the spec was ambiguous, then that the build is wrong,
   and only last that the scenario is wrong (`references/holdout.md`, section 7).
5. Show the owner what landed and the scores. Mark the chunk done in the
   ledger. Commit.

**Autonomous.** Hand `spec/plan.md` to `run_build_plan`. It builds the
conflict and dependency graph from each chunk's **Files:**, then runs waves:
every chunk whose dependencies are green and whose files overlap nothing in
flight goes out together, each in its own worktree. Each chunk is reviewed,
scored against its own scenarios and attacked by a skeptic before it lands
(only a break of the chunk's contract holds it back; what the skeptic finds
beyond the contract is a follow-up for the ledger, never a new requirement),
and each phase is scored again against the sealed suite before the next
starts. Then lead the run from this turn with `build_next`: it waits for the
build and returns each batch's reports and reviews, each decision that needs
you (answer with `build_decide`) and the end. Read what it returns, check
anything you doubt, and call it again; the build waits for you between
batches. Do not poll any other way. If your turn ends first, the build goes on
by its own rules and the chat is woken when it needs a decision or ends.
Decide engineering questions and record
them; park product, taste, money and risk questions and keep the run moving.
The ledger, not the conversation, holds the state.
`references/autonomous.md`.

In both modes, mid-build "can it also..." defaults to no: add it to a v2 list.
Scope creep ends more new builds than technical mistakes do.

### 8. Finish gates

When every chunk is green: the whole suite end to end and the real build (on
a real phone, for an app used on one), agents that try to break the assembled app, a code-quality sweep, a security
review, and a look-and-feel pass. Fix what they find and judge it again.
`references/gates.md`, sections 1-5.

### 9. Walkthrough and report

Bring `ARCHITECTURE.md` up to date and walk the owner through what was built:
one request end to end, the data, the decisions that mattered, where each
done-list item lives, what is fragile. Check it landed with a few questions.
Then give the completion report: shipped, parked, failed, descoped, each gate's
result, the real tier. `references/gates.md`, sections 6-7.

The owner can hand off the building. They cannot hand off understanding it.

## Resuming a build

A build spans sessions: a long run gets compacted or interrupted. On "resume", or when invoked in a folder
that already has `spec/ledger.md`: read the ledger, run the wall probes if it
says they are unproven, skip what is done or `green`, and continue from the
recorded phase. Never re-interview or re-plan what the ledger shows as settled.

## Strong defaults

- **The spec wins.** When spec and code disagree, the code changes. If you keep
  "fixing" the spec to match the code, you have inverted the relationship. An
  agent's proposed spec edit is a proposal, judged on its merits.
- **Scenarios before chunks, sealed before building.** No exceptions for the
  part that "is obvious".
- **The orchestrator never scores a scenario.** It wrote the spec; the judge
  did not.
- **Run scenarios against the live app.** A scenario that passes against a mock
  and fails against reality is not a scenario.
- **The spec grows during the build, by clarification only.** A misbuilt chunk
  shows what the spec left ambiguous or said two ways. Add that clarification;
  do not only fix the code. What a reviewer finds beyond the spec is not a
  clarification: it is a follow-up in the ledger, or a question for the owner.
- **`spec/` and `twins/` are committed from day one**, in the same repo as the
  code. The suite has its own repository, outside it.
- **Out of scope is sacred.**
- **State the tier honestly.** Never report a higher one than was built.
- **Commit per chunk. Never deploy, publish or push.**

## Anti-patterns

- **Building before scenarios exist.** Ten minutes of scenarios prevents hours
  of "it works but not how I meant".
- **A suite the builders can reach**: in the repo, or named in a brief.
- **One enormous chunk.** "Build the MVP" is not a chunk.
- **Parallelizing before the skeleton**, or by "feature" instead of by files.
- **Forcing a chunk green**: a test that cannot fail, a retry until it passes,
  a scenario quietly declared wrong.
- **Answering the owner's questions for them** to keep an unattended run
  moving.
- **Twins for services that do not need one.**
- **A triumphant summary** that buries the parked, the failed and the real
  tier.
- **Ending at green.** No break-it pass, no security review, an owner who
  could not say how their own app stores its data.

## When to skip this skill

- **A single-file script or one-off tool.** Just build it.
- **A throwaway prototype** to see whether an idea is interesting. Build it in
  chat; come back here once it is real.
- **A feature in an app that already exists.** `/brownfield`,
  `/vibe-code` or `/senior-engineer`.
- **An existing repo that needs structure.** `/new-project`, retrofit mode.
- **The owner is thinking out loud.** "What would it take to build X?" is a
  question. Answer it.

## The one-liner

> **Interview until nothing is left to guess, seal the tests, lay the
> foundation, build in chunks the judge scores, then break it, review it and
> explain it before calling it done.**

## Where this came from

- `/app-build`: the interview, constitution, spec, held-out scenarios, twins,
  and the supervised loop.
- The autonomous build skills: the tier, the ledger, the conflict graph,
  waves in worktrees, the skeptic, deciding versus parking.
- `/new-project`: the foundation phase. Its kit is written by `project_kit`,
  its templates read with `protocol`.
- Andrej Karpathy, "From Vibe Coding to Agentic Engineering" (Sequoia AI
  Ascent, April 2026): write a detailed spec with the agent and state the
  constraints it would guess; have other agents try to break the result; use
  several judges for what cannot be checked directly; keep the quality and
  security bar; keep taste with the owner; you can hand off the thinking but
  not the understanding.
- Added here: the seal on the suite, the security gate, and the
  owner walkthrough.
