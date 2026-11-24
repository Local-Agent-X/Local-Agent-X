# Intake and spec

How to get from a one-line idea to a spec an agent can build from without
guessing. Read this at phases 1-3 and 5.

## Contents
1. The interview
2. Constitution
3. `spec/product.md`
4. `spec/architecture.md`
5. `spec/design.md`
6. Tier
7. Twins
8. `spec/plan.md`

---

## 1. The interview

An agent fills every gap in a spec with whatever is most common in its training
data. That answer is usually plausible and often wrong for this owner: accounts
keyed by email when they needed a stable ID, a login wall on an app meant for
one person. The interview exists to find those gaps while they cost a sentence
to fix.

Ask in batches, and only about what the opening message left out. Use
`ask_user` when the answers are choices. Give a recommended answer with
each question so the owner can say "yes" instead of composing one.

**Who and why**
- Who is this for, specifically? One real person or role, not "users".
- What is the single most important thing it does for them?
- What does success look like a month after it ships?

**Shape**
- What does it touch: accounts, payments, email, files, other services?
- What must it never do? (lose data, send without confirming, cost money per use)
- What is explicitly out of scope for this version?

**Constraints the agent must not guess** (each of these has a common default
that is frequently the wrong one)
- Identity: what is the stable key for a user or record? Never assume email.
- Data: where does it live, who else can see it, what happens on delete?
- Money and limits: anything metered, rate-limited or billed?
- Stack, hosting, deadline, budget: anything already decided?

**Look and feel** (taste is the owner's; ask before anything is drawn)
- Two or three existing products or pages it should feel like, and one it
  should not.
- Tone of the words: plain, playful, formal?
- Light or dark by default, dense or roomy, phone-first or desktop-first?

Keep going until you could not be surprised by the owner's reaction to the
finished app. Then write the brief: one paragraph, inline in chat, and confirm
it before any file is written.

In autonomous mode this interview is the owner's main contribution, because
nobody will be there to ask later. Spend longer here, not less.

## 2. Constitution

`spec/constitution.md`: 5-12 rules the build must respect no matter what an
agent thinks is clever. They settle arguments before they happen, and every
chunk brief carries them.

Take them from the interview's "never" and "constraints" answers, then add
sane engineering defaults for the stack. Examples:

- "Every record is keyed by a generated ID. Email is an attribute, never a key."
- "All external service calls go through an adapter so they can be swapped for fakes."
- "No secrets in code. Config comes from env vars; `.env.example` is committed, `.env` is ignored."
- "Every destructive action is reversible or gated by an explicit confirm."
- "Every endpoint that returns or changes a user's data checks that the caller owns it."
- "Errors reach the user as text they can act on. No silent fallback."
- For an app on a phone: "The core flow logs each stage to the device log under
  one tag (`<Tag> stage=<name>`, with where it ran and how long it took), and
  never logs the user's data." Without it the finish gates cannot show the flow
  ran on the device (`references/gates.md`, section 1). Write the same names
  into `.lax-device.json` at the project root, which `device_check` reads:
  `{"package": "<app id>", "tag": "<Tag>", "stages": ["<name>", ...],
  "private": ["<a test value entered on the phone>", ...]}`.

Show the draft, take additions and removals, then write the file.

## 3. `spec/product.md`

The what.

- One-paragraph summary.
- The primary user and the job they are hiring the app for.
- **Done-list:** the user-visible behaviors that mean it works, each one
  checkable. This is what "finished" is measured against.
- Core flows, numbered, step by step, with the expected outcome of each step.
- Data model in prose: entities, relationships, lifecycle states.
- **Out of scope:** an explicit list. It saves more time than any other section.

If you catch yourself writing "handles X appropriately", stop and say what
appropriately means.

## 4. `spec/architecture.md`

The how, at system level.

- Stack choices, one sentence of justification each.
- Component layout.
- External services and the adapter boundary for each (where a twin plugs in).
- Auth model.
- Data store and how its shape changes over time.
- Where it runs (see Tier).

This file feeds `ARCHITECTURE.md` during the foundation phase. The spec says
what was intended; `ARCHITECTURE.md` says what exists and who owns it.

## 5. `spec/design.md`

The look and feel, from the interview: the reference products, tone, default
theme, density, target screen. A handful of lines is enough. It exists so a UI
chunk has something to match and a judge has something to score against.
Skip it for a project with no interface.

## 6. Tier

State where the app will run, up front, and hold the final report to it:

| Tier | What it is | What "done" can mean |
|---|---|---|
| 1 | Static or single-file, runs anywhere | Works when opened |
| 1.5 | Real backend, hosted on the owner's machine | Works while that machine is on |
| 2 | Deployed, always on | Works for everyone, all the time |

Claiming a higher tier than was built is the most common lie in a new-app
report. Deploying is always the owner's action.

## 7. Twins

For each external service in the architecture, decide real or twin:

- **Real:** read-only, cheap, no rate limit in development, no effect on real people.
- **Twin:** costs money per call, sends real email or SMS, changes real state,
  is rate-limited, or cannot run in CI.

A twin is a stand-in that honors the service's contract. Write
`twins/<service>.md` with the endpoints, request and response shapes, the state
it keeps and the edge cases; build it as the cheapest thing that lets the
scenarios run (a fixture set, a mock at the adapter boundary, a tiny server).
A twin is infrastructure, so build one only when a real development key will
not do. No external services: no `twins/` folder.

## 8. `spec/plan.md`

The ordered chunk list. Two rules:

- **Each chunk is a vertical slice:** one capability end to end (data, logic,
  interface), not "all the backend".
- **Order by dependency:** the foundation first, auth before anything
  per-user, read paths before write paths, the happy path before edge cases.

Per chunk, record:

```markdown
## Phase B — Accounts
### Chunk 3 — User profile page
- **Class:** leaf
- **Slice:** done-list 4; product.md flow 2
- **Files:** src/routes/profile.tsx, src/api/profile.ts
- **Depends on:** 1, 2
- **Scenarios:** 4, 5
- **Done when:** a signed-in user edits their name and sees it after a reload; its tests pass
```

`run_build_plan` parses exactly this shape: **Class** is `trunk` or `leaf`
(the foundation is `trunk`), **Slice** is what it covers, **Files** its
footprint, comma-separated, and **Scenarios** the numbers of the scenario files
that verify it (`04-edit-name.md`), or `—`. Group chunks under `## Phase`
headings: the judge scores a phase's scenarios when its last chunk lands.

- **Class** decides how it is built: `trunk` (auth, data layer, anything other
  code depends on) gets `/senior-engineer` discipline and a read of the diff;
  `leaf` (a screen, an isolated feature, glue) gets `/vibe-code` discipline and
  is verified by behavior.
- **Files** is what autonomous mode schedules on. A chunk whose footprint
  you cannot predict is mis-scoped; split it.
- A chunk that would take more than one agent session is two chunks.
- **A rule over open-ended input says how far it reaches.** Some rules cover
  input no list can exhaust: any text a person types, any file, any label.
  Where a chunk states one, mark it `(strict)` or `(scoped)` and give it
  examples. `strict`: it must hold for every input, and one input that breaks
  it fails the chunk. Keep it for safety, money and data-loss rules, and expect
  it to cost review rounds. `scoped`: it is judged on its examples and on
  inputs of the same kind; an input of a new kind is a follow-up in the ledger,
  for a later chunk or for v2. A rule that is not marked is scoped. Which one a
  rule is belongs to the owner: ask when the rule is written, in the interview
  or at the plan's approval, not when a reviewer finds the first odd input.
