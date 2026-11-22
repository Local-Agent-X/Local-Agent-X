# Finish gates

Passing its scenarios means the app does what was expected. It does not mean
the code is sound, safe, or understood by the person who owns it. These gates
run once every chunk is green, in both modes, and the app is not reported as
done until each one has an honest result. Read this at phase 8.

## Contents
1. Integration
2. Break it
3. Code quality
4. Security
5. Look and feel
6. Owner walkthrough
7. Completion report

---

## 1. Integration

Chunks that pass alone still drift at the seams between them.

- **The whole suite, end to end,** against the assembled app: the judge runs
  "all" (`references/holdout.md`, section 6).
- **The real build:** `check` and `build`, not a typecheck. For a compiled
  target, run the artifact and show its output.
- **The project's own tests** green from a clean checkout, including a test at
  each place two chunks meet through a contract (one side produces, the other
  consumes). Add the missing ones now.
- **Tier check:** what was built matches the tier the spec claimed.

## 2. Break it

A skeptic per chunk tests each piece; nobody has yet attacked the whole. Spawn
two or three agents with different briefs, each against the running app and the
full source, each told to default to "broken":

- **The hostile user:** bad input, wrong order, double submits, back button,
  two tabs, a second account reaching the first one's data.
- **The unlucky user:** the network drops, the service behind an adapter fails
  or is slow, the disk is full, the session expires mid-flow.
- **The auditor:** tests that cannot fail, a `spec/` promise with no code
  behind it, a done-list item that only works on the happy path.

Every finding is fixed (as a chunk, judged like any other) or reported. A
finding is never dropped because the suite passed.

## 3. Code quality

Working code can still be bloated, duplicated, or resting on an abstraction
that will not survive the next feature, and models are poor at simplifying
their own output unasked. Parallel builders make this worse: each one writes
the helper it needs.

- **The mechanical half already ran:** size caps, canonical drift, owners, doc
  paths (`check`). Read the "Nearing the size cap" section of the map; a file
  in the warning band after a first build is a split waiting to happen.
- **Duplication:** sweep for one job done twice under different names
  (a `reviewer` agent, `agent_spawn`, with that brief).
  `refs --duplicates` lists the name-level ones.
- **Dead weight:** code no flow reaches (a `reviewer` agent with that brief).
- **Shape:** one read-only reviewer over the trunk chunks, asking whether a
  restructuring would make whole branches, helpers or layers disappear
  (`agent_spawn` with the `reviewer` role).

Apply what is behavior-preserving and re-run the suite after. In autonomous
mode apply only what the scenarios and tests can prove unchanged; report the
rest as recommendations. A simplification nobody verified is a new bug.

## 4. Security

Building fast does not excuse a vulnerability; the owner answers for the app
either way. Have a `reviewer` agent review the whole diff from the first commit for security,
and check by hand the things a new app most often gets wrong:

- every endpoint that returns or changes a user's data checks the caller owns it;
- input is validated at the boundary, and nothing user-supplied reaches a
  query, a shell, a file path or HTML unescaped;
- no secret is in the repo, the history, a log line or a client bundle;
- sessions and tokens expire, and logout ends them;
- dependencies: the ecosystem's audit (`npm audit`, `pip-audit`, `cargo audit`)
  has nothing high or critical unaddressed;
- every constitution rule about data or risk has code and a test behind it.

Fix what is found and re-judge. Anything left open is named in the report with
its risk. "Is this handling of user data acceptable?" is the owner's question;
park it, do not answer it.

## 5. Look and feel

Skip for a project with no interface.

- If the UI is still framework-default, give it a design system first: tokens,
  type, spacing, one accent.
- The `judgment` scenarios go to the panel (`references/holdout.md`, section
  6), scored against `spec/design.md`.
- Screenshots of the main flows go in the completion report. Taste is the
  owner's call; show it, do not declare it good.

## 6. Owner walkthrough

The owner can hand off the building. They cannot hand off understanding what
was built: they will be the one deciding what to change next, and they are
responsible for it. A build that ends with code its owner could not describe is
not finished. This gate is the last one in both modes; in autonomous mode it is
the first thing that happens when the owner returns.

Bring `ARCHITECTURE.md` up to date first (it is the artifact this leaves
behind), then walk the owner through it, in plain language, in this order:

1. **One request, end to end.** Pick the main flow and follow it through the
   real files: where it enters, what each module does to it, where the data
   lands.
2. **The data.** What is stored, where, keyed by what, and what happens on
   delete.
3. **The decisions that mattered.** The handful recorded as ADRs and in the
   ledger: what was chosen, what was turned down, what it rules out.
4. **Where each done-list item lives.** One line each: the module and the
   scenario that covers it.
5. **What is fragile.** The parts most likely to break when the app grows, and
   what in the report is unfinished.

Then check it landed. Ask three to five questions the owner can only answer if
they followed: "A user changes their email. What else changes?" "Where would
you add a second payment provider?" "What stops user A reading user B's
orders?" Where an answer is off, explain that part again a different way. Keep
it short; the goal is a correct picture, not an exam.

Record in the ledger that the walkthrough happened and what was re-explained.
Until then the report says "walkthrough pending".

## 7. Completion report

Nobody watched most of this, so the report is the deliverable. It has these
parts and hides none of them:

- **Shipped:** what works and passed the sealed suite, with the scores.
- **Parked for you:** every product, taste, money or risk question, each with
  the context to decide it.
- **Failed and abandoned:** what could not be made to pass, with the diagnosis.
- **Descoped:** what the idea implied that was deliberately left out, and why.
- **Gates:** integration, break-it, quality, security, look and feel,
  walkthrough: the result of each, including "not run" and why.
- **Real tier:** what was actually built, and what the next tier would take.
- **Where things are:** the repo, the suite (per-machine, in LAX's data
  folder under holdout/<project>), the ledger.

Never deploy, publish or push. Shipping to the world is the owner's action.
