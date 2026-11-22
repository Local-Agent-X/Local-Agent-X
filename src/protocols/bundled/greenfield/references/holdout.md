# The held-out scenario suite

The suite is how the build finds out whether the spec was right. It only works
if the agents that build the app never see it: a test a builder can read is a
test it builds to. Read this at phase 4 and whenever a chunk is judged.

## Contents
1. Where it lives
2. Writing scenarios
3. The scenario index
4. Sealing the suite
5. Proving the wall
6. Judging
7. When a scenario fails
8. Revising the suite

---

## 1. Where it lives

In LAX's data folder, outside the project: `holdout_write` puts each scenario
there by project name. Inside the repo every worktree would get a copy, a
`glob` for `*.md` would find it, and the app's folder is served. No tool call
can reach that folder, in any file-access mode; only the judge reads it.

It is per-machine. Say so in the completion report.

## 2. Writing scenarios

Write them from the spec, before any chunk is built. Written afterwards, they
describe what the agent built instead of what the owner wanted.

Pick the ones that most separate a working app from a broken one:

- the primary happy path for each done-list item;
- the two or three failures that would embarrass the owner in production;
- the edge case the spec was vaguest about;
- one scenario per constitution rule that behavior can show (the record
  survives an email change; another user's data is refused).

5-8 for a small app in supervised mode. Autonomous mode needs more, because the
suite is the only reviewer: every done-list item covered, and every chunk in
the plan verified by at least one scenario.

One file per scenario, numbered so the plan can cite it, `<nn>-<short-name>.md`:

```markdown
# Scenario: <short name>

**Persona:** <who is doing this>
**Context:** <what is true when they start>
**Steps:**
1. They do X
2. They expect Y
3. They do Z

**Satisfaction criteria:**
- <the thing they expected actually happens>
- <edge case A is handled, specifically: ...>
- <the state afterwards is ...>

**Kind:** checkable | judgment
```

Prose, not code. `checkable` means one judge can decide it from what the app
does. `judgment` means it turns on taste (does this read clearly, does the page
match `spec/design.md`) and goes to a panel (section 6).

Show the owner the scenarios before sealing. This is the last time anyone but
the judge reads them.

## 3. The scenario index

The orchestrator has to say which scenarios to run without reading them. Before
sealing, write the index into `spec/ledger.md`:

```markdown
## Scenario index
| File | Kind | Covers |
|---|---|---|
| 01-checkout-happy.md | checkable | done-list 2; product.md flow 3 |
| 02-declined-card.md | checkable | done-list 2; constitution 4 |
| 03-first-impression.md | judgment | design.md |
```

File names and coverage only. No steps, no criteria.

## 4. Sealing the suite

Show the owner the scenarios first. Then call `holdout_seal` with the project
name. From then on no one can add or change a scenario, and no tool call
reaches the folder, for the builders and for the orchestrator alike. LAX
enforces it, so there is nothing to install. That is the point: a later
session of the orchestrator cannot paste scenario text into a brief, because
it cannot read it.

Refer to scenarios by file name from the index; `holdout_judge` knows where
they are.

## 5. Proving the wall

A wall that never refused anything has not been tested.

- Spawn a throwaway worker (`agent_spawn`) with a prompt that describes the
  folder: "LAX's data folder holds a folder named holdout. Try to read, list
  or search any file under it, by any tool, and report exactly what
  happened." Every attempt must come back refused.
- Once the app can start, run `holdout_judge`: it must score the scenarios.

If the first probe gets through, stop and tell the owner: the wall is broken,
and a build scored against a suite its builders can read means nothing.
Record both outcomes in the ledger, honestly.

## 6. Judging

Make sure `.lax-launch.json` starts the app for real (not a mock of it), then
call `holdout_judge` with the project and the file names from the index (or
none, for all).

The judge returns, per scenario, `pass | fail | not-run`, a 0-10 score, what it
observed, and the gap stated as behavior.

- **`checkable` scenarios:** one judge.
- **`judgment` scenarios:** call `holdout_judge` three times for them and
  take the majority; report a split as a split. A model is a poor critic of its
  own habits, so say in the report which model judged.
- The orchestrator never scores a scenario itself. It wrote the spec, so it
  reads the app the way the spec meant, which is the bias the suite exists to
  remove.

## 7. When a scenario fails

Assume, in this order:

1. **The spec was ambiguous.** Fix `spec/`, then rebuild the chunk. The spec
   grows over a build; every failure teaches what was unclear.
2. **The build is wrong.** Send the chunk back with the gap.
3. **The scenario is wrong.** Rare. Be suspicious of yourself, and take it to
   the owner (section 8).

Hand a builder the gap as the judge wrote it, tied to the spec: "product.md
flow 3 says the cart survives a declined card; observed: the cart was empty."
Never more than that. The builder fixes the behavior the spec promised; it does
not learn what the test checks.

When the spec and the code disagree, the spec wins and the code changes. An
agent that proposes editing the spec to match what it built is proposing to
move the target; treat it as a proposal and judge it on its merits.

## 8. Revising the suite

Only the owner changes a sealed suite, by editing the file in LAX's data
folder themselves. In
autonomous mode a suspected-wrong scenario is parked for the owner and the
chunk it blocks is marked `parked`, never forced green.
