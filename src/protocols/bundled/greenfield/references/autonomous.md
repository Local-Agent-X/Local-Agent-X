# Autonomous mode

One approval, then the build runs unattended, in parallel where it is safe, for
as long as it takes. Read this at phase 7 when the owner chose autonomous mode.

Taking the human out of the loop means replacing them with four things: a
**ledger** that holds the plan so the conversation does not have to, a
**scheduler** that knows what can run together, a **judgment policy** that
decides the engineering and parks the rest, and **adversaries** that try to
break every chunk before it counts. Get those right and the run can be trusted
unwatched. Get them wrong and it is confidently wrong for three hours.

## Contents
1. The one approval
2. The ledger
3. The conflict and dependency graph
4. Waves
5. The chunk brief
6. Judging a chunk
7. Deciding versus parking
8. Compaction and resume

---

## 1. The one approval

Everything the owner must decide is decided before the run starts, because
nobody will be there to ask. Phases 1-5 are done with the owner as in
supervised mode: the interview, the constitution, the spec, the look and feel,
the sealed suite, the plan. Then present once:

- the one-line restatement and the done-list;
- the spec and constitution (already seen; note anything changed since);
- the scenario index (names and coverage, not the scenarios);
- the tier;
- the chunk plan and the graph: the serial foundation, then which chunks run
  together and which wait;
- what is explicitly not being built;
- the outcome of the wall probes.

Wait for a yes. That is the only mandatory stop. After it, the run continues
until the completion ledger, and a question that is the owner's to answer is
parked, never asked mid-run.

## 2. The ledger

`spec/ledger.md` is the source of truth, not the conversation. It holds the
scenario index, the graph, every chunk's status, the decisions made and the
questions parked.

```markdown
## Chunks
| # | Name | Kind | Status | Wave | Notes |
|---|---|---|---|---|---|
| 1 | foundation | foundation | green | 0 | commit abc123 |
| 2 | accounts | trunk | in-flight | 1 | |
| 3 | catalog page | leaf | pending | 1 | |

Status: pending | in-flight | green | parked | failed

## Decisions (engineering, made by the orchestrator)
- <date> chunk 2: sessions in a signed cookie, not a table. Why: single machine (tier 1.5), no revocation in scope.

## Parked for the owner
- chunk 5: should an expired trial lock the account or only the paid features? Context: ...

## Wall probes
- builder probe: refused. judge: scored 9 scenarios.
```

Only the orchestrator writes it, on the main checkout. Hold a pointer to the
ledger and one chunk in context; that is what lets the run survive compaction
and a crash.

## 3. The conflict and dependency graph

Parallelism is decided by files touched, never by "feature". Two kinds of edge:

- **Conflict:** two chunks' footprints share a file. They serialize.
- **Dependency:** chunk B uses what chunk A produces. B starts as soon as A
  lands.

Everything with no edge between it runs together. Watch the conflict magnets:
the schema, the router, shared types, registries, barrel exports, config
tables. Chunks that all register into one registry conflict on that file even
when they feel independent; serialize them or funnel the registrations through
one chunk.

The foundation is wave 0 and gates everything: before the skeleton exists there
are no seams, so there is nothing disjoint to parallelize.

Rank by risk as well. A chunk that edits a shared anchor (a default, an enum, a
policy table, a widely imported type) goes late, behind the safe majority.

## 4. Waves

A wave is every chunk whose dependencies are green and whose footprint overlaps
nothing in flight.

- **Engine:** `run_build_plan`. It reads the graph from `spec/plan.md`
  (**Depends on:** and **Files:**), dispatches each wave together, merges each
  chunk back as it goes green, and survives a restart; `build_next` leads it
  from your turn, `build_plan_status` shows where it is and `build_plan_resume`
  continues a halted run.
- **Isolation:** every chunk that writes files gets its own git worktree. Merge
  each back as it goes green, and resolve merges at the orchestrator.
- **One agent owns one chunk owns one worktree.** Splitting a chunk across
  agents loses ownership, verification and rollback at once.
- The orchestrator does not edit product code itself, except to resolve a merge.
- Commit per chunk, so each is reversible and bisectable.

## 5. The chunk brief

A builder gets only what the brief says; it inherits nothing. `run_build_plan`
writes each brief from the chunk and `spec/`; this is what a brief must carry,
so write the chunk so the engine's brief can. A brief is
complete when a fresh agent could finish the chunk from it alone:

- the chunk from `spec/plan.md` (name, kind, covers, footprint, depends on);
- the spec sections it implements, by path, and `spec/constitution.md`;
- `spec/design.md` for anything with an interface;
- the discipline, written out (a builder does not invoke skills):
  - *Build to the spec.* "Build the smallest correct thing that satisfies the
    spec for this chunk. If the code cannot match the spec, return
    `spec-conflict` with what the spec says and what the code requires. Do not
    adjust the spec."
  - *Extend the seam.* "The skeleton defines where this plugs in. Extend that
    seam; do not create a parallel one. If it is not there, return
    `seam-not-found`."
  - *Shared files.* "Before editing a shared file (schema, shared types,
    router), list what depends on it (`deps` / `refs --depth 2`) and run those
    tests."
  - *Quality.* "No speculative generality, no swallowed errors, no type
    escapes. Match the skeleton's conventions. `check` must pass."
  - *Tests.* "Add the tests this chunk needs, for behavior, in the project's
    test layout. Never a test that cannot fail."
  - *Scope.* "Touch only your footprint. Do not spawn agents. Work from
    `spec/`; the acceptance suite is sealed and attempts to reach it are
    refused."
  - *Run it for real.* "If this produces something runnable, run it and show
    the real output. Never claim parity from a stand-in."
- what to return: files changed, how it was verified, any `spec-conflict`,
  `seam-not-found` or open question.

## 6. Judging a chunk

When a builder returns, three things happen before the chunk is `green`.
`run_build_plan` does all three itself: its build gate re-runs the build and
the tests, then it scores the chunk's **Scenarios:** and sets a skeptic agent
on the diff. A failure sends the chunk back with the finding, round by round
while each round changes what the review says. A chunk that is still not
green is set aside with its work kept on its branch, and the run builds on
with every chunk that does not depend on it. The run's summary lists each
skeptic's follow-ups: record them in the ledger.

1. **Re-verify independently.** Run `check` and the tests yourself; confirm the
   named seam was used, not a new file beside it.
2. **The judge** runs the chunk's scenarios from the index against the running
   app (`references/holdout.md`, section 6).
3. **A skeptic** agent gets the diff, the claim and the chunk's contract (its
   slice, its done-when and `spec/`): "This change says it is done and
   correct. Prove it wrong: the input it breaks on, the case it missed, the
   seam it forked, the test that cannot fail."

A skeptic's finding counts against the chunk only when it shows one of:

- a done-when line or a `spec/` rule the change breaks, quoted as written;
- a crash, lost or corrupted data, or a security hole;
- a test that cannot fail, or a claim in the builder's report the code does
  not back.

Anything else it turns up (an input the spec never names, behavior the spec
leaves open, a design it would have chosen differently) is a **follow-up**: a
line in the ledger, and the chunk is still green. The spec says what done is; a
reviewer does not add to it. Unsure whether the change does what the contract
says: broken. Unsure whether the contract covers the case at all: follow-up.

A rule over open-ended input (any text, file or label a person might bring)
reaches as far as it is marked. A `strict` rule must hold for every input: one
input that breaks it is a break. A `scoped` rule is judged on the examples
listed with it and on inputs of the same kind: an input of a new kind is a
follow-up. A rule that is not marked is scoped. The plan marks them
(`references/spec.md`, section 8); the skeptic does not re-mark them.

Green means the scenarios pass **and** the skeptic shows no such break.
Otherwise the chunk returns to `pending` with the finding attached (the judge's
gap as written, the skeptic's finding in full), or to `parked` if it needs the
owner. A finding sends the chunk back to be fixed. It never becomes a new line
in `spec/plan.md` or `spec/`: only the owner's decision, or a contradiction
settled under section 7, changes those.

## 7. Deciding versus parking

Classify every question a chunk raises, and never stall the run on one item.

- **Engineering** (which library, which pattern, how to structure a module,
  retry or rework): decide as the best senior engineer on the team would, from
  the spec and the constitution. Record the decision and one line of why in the
  ledger. Continue.
- **Product, taste, money or risk** (what should this screen say, is this in
  scope, what does it cost, is this data handling acceptable): do not answer.
  Park it with enough context to decide later, and route around it: keep
  running every chunk that does not depend on the answer. A new app raises many
  of these; the interview should have caught most, and each one parked is a
  question the next interview should ask.
- **`spec-conflict` / `seam-not-found`:** re-plan the chunk against the spec
  and the skeleton. If that needs a call that is the owner's, park it.
- **A suspected-wrong scenario:** park it. Never force the chunk green.
- **Repeated failure:** after two honest attempts, stop. More retries invite a
  faked pass. Mark it `failed` with the diagnosis and move on.

## 8. Compaction and resume

Compact freely; nothing load-bearing is in the conversation. To resume after a
compaction, a crash or a new session: re-read `spec/ledger.md`, skip everything
`green`, re-dispatch anything `in-flight`. `build_plan_resume` continues a halted
run.
