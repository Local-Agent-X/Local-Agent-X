# Templates

Fill these in for the actual project. Replace every `<...>`; delete any section
that would be empty rather than leaving a placeholder an agent will trust.

## Contents
1. AGENTS.md (root rules)
2. ARCHITECTURE.md (meaning)
3. Module guide (per-module AGENTS.md)
4. ADR
5. docs/history/README.md and the history banner

---

## 1. AGENTS.md

Rules, not descriptions. Keep it under ~100 lines: it loads into every agent
session, so every line costs context on every turn. Description of what the code
does belongs in ARCHITECTURE.md; numbers belong in the generated map.

```markdown
# AGENTS.md — rules for anyone changing this repo

Read first: [ARCHITECTURE.md](ARCHITECTURE.md) (what owns what) and
[docs/codebase-map.md](docs/codebase-map.md) (generated: modules, importers,
dependencies, oversized files). When a number in prose disagrees with the map,
the map wins.

## Commands

| Task | Command |
|---|---|
| Full check (run before saying "done") | `<npm run check>` |
| Tests | `<npm test>` |
| Regenerate the map after adding/moving modules | `<npm run docs:map>` |
| Who depends on a module | `<npm run deps -- src/<module>>` |
| Who uses a function, class, type or member | `<npm run refs -- <Name>>` (or `<Class.member>`, `<file>#<Name>`) |
| Exported names declared in two places | `<npm run refs -- --duplicates>` |
| A name declared in two source roots (apps, packages) | `<npm run check:canonical>` |
| How far a change reaches, hop by hop, and the tests to run | `<npm run refs -- <Name> --depth 2>` (declarations), `<npm run deps -- <path> --depth 2>` (files) |

## Layout

| Path | Holds | Rules |
|---|---|---|
| `src/<module>/` | one capability per module | public surface = `index`; outside code imports nothing else |
| `docs/adr/` | decisions and why | add one when you pick between real alternatives |
| `docs/history/` | finished plans, campaign logs | read-only record; never cite as current |

## Code rules

- **Size caps, in code lines: <400> per file, <100> per function.** A line counts when it holds code; comment and blank lines are free. A function's count is its own: a function nested in it counts for itself. Warnings start at <320> / <60> and are listed in `docs/codebase-map.md` under "Nearing the size cap"; they never fail. Enforced by `<check:size>`.
  - Why: an agent finds its way by reading a whole file or function; past the cap it is almost always doing a second job.
  - Near or over a cap: find the job that grew and move it into a module (or function) named after that job. Never delete comments to fit (they don't count), and never name a split, a file or a commit after the limit ("part 2", "under the 400-line cap").
  - `.code-size-ratchet` lists what was over a cap when the caps were adopted (a retrofit; a new project has none), at its recorded size. It may only shrink.
- **One responsibility per file and per module.** A new capability gets its own module, not a corner of an existing one.
- **Import a module through its public entry.** If you need an internal, export it from the entry. Enforced by the module-seal test.
- **Extend the existing owner.** Before writing a new subsystem, find the module that owns the concern (ARCHITECTURE.md) and extend it. Before writing a function, run `refs` / `--duplicates` for the name you'd give it. Something both apps need goes in `<the shared package>` and is imported, never copied: `<check:canonical>` fails on a second copy.
- **Read before you edit.** Open the file and its module guide first.

## Coupling rules

- If two places must change together, a test fails when only one does. Never
  write "remember to also update X" in a doc — write the test, then list it here.
- Registries are declared once; every derived table comes from that declaration
  or is checked against it by a completeness test.
- A string two modules share (an event name, a metadata key, a file format, a
  rendered header someone parses) is declared once and both sides import it.

Couplings in this repo (kind → its one declaration → its guard):
- Imports → `docs/codebase-map.md` → map freshness, `<src/module-seals.test.ts>` (seals + forbidden dependencies)
- `<...>`

## Growing the repo

- New module → give it a row in ARCHITECTURE.md's subsystem table (what it owns, what it doesn't) and regenerate the map. `<check:owners>` fails the build until it has one.
- A module reaches ~5 outside importers → add a seal row and a module guide (`src/<module>/AGENTS.md`).
- A decision between real alternatives → `docs/adr/NNNN-<slug>.md`.
- A plan or campaign finishes → move its doc to `docs/history/` with the banner.

## When in doubt

Ask. Don't guess at product, money, security, or taste calls.
```

---

## 2. ARCHITECTURE.md

The meaning layer: which code owns which capability, and how one request flows
through. No counts, no file sizes; those drift, and the map owns them.

```markdown
# Architecture

What owns what. Structural facts (importer counts, dependencies, oversized
files) are generated in [docs/codebase-map.md](docs/codebase-map.md); this doc
owns the meaning. Rules live in [AGENTS.md](AGENTS.md).

## Read these first (in order)

1. `<src/index.ts>` — process entry: <what it wires up>.
2. `<...>` — <the core loop / request handler>.
3. `<...>` — <the single table or registry that governs the system>.

## How a request flows

1. <entry point> receives <X> →
2. <module> <does Y> →
3. ...

## Subsystem map

Every module under `src/` has a row here or its own `AGENTS.md`; the build
checks it. Say what a module does NOT own when a neighbour is easy to confuse
with it.

| Capability | Owner (canonical code) | Notes |
|---|---|---|
| <Auth> | `src/auth/` (entry `index.ts`) | <the one thing an outsider must know; what it does not own, and who does> |

## Don't trace into

| Path | Why |
|---|---|
| `<src/legacy-x/>` | superseded by `<src/x/>`; kept until <condition> |
```

---

## 3. Module guide (`src/<module>/AGENTS.md`)

Under ~25 lines. Written for an agent about to edit this module. Add one when
a module reaches ~5 outside importers, or sooner for anything security-relevant.

```markdown
# <module>

**Owns:** <the capability, in one sentence>.
**Does not own:** <the adjacent concern people confuse it with> → `src/<other>/`.
**Public entry:** `index.ts` — outside code imports only this (sealed).

## Invariants
- <rule that, if broken, causes a bug elsewhere>

## Coupled to
| If you change | Also verify | Guard |
|---|---|---|
| <the schema in types.ts> | `src/<consumer>/` | `<consumer>.contract.test.ts` |

## Tests
`<npm test -- src/<module>>`
```

If the agents in use don't auto-load nested `AGENTS.md`, put a one-line
`CLAUDE.md` beside it containing `@AGENTS.md`. Don't copy the text into a
second file; two copies drift.

---

## 4. ADR (`docs/adr/NNNN-<slug>.md`)

Numbered, never renumbered, never deleted. A reversed decision gets a new ADR
that supersedes the old one; edit only the old one's Status line.

```markdown
# NNNN. <Decision, stated as the choice made>

**Status:** Accepted (YYYY-MM-DD) · Supersedes: — · Superseded by: —

## Context
<The forces at play, and the alternatives that were real options.>

## Decision
<What we do. One paragraph.>

## Consequences
<What gets easier, what gets harder, what is now forbidden.>

## Revisit when
<The concrete signal that would make this worth reopening.>
```

Seed new projects with `0001-record-architecture-decisions.md` explaining
why ADRs exist: decisions that live only in chat or one person's notes are
invisible to the next agent.

---

## 5. History

`docs/history/README.md`:

```markdown
# History

Finished plans, campaign logs, and design docs for shipped work. They describe
the code as it was. Paths here are not kept current and are not checked.
For the current design, start at [ARCHITECTURE.md](../../ARCHITECTURE.md).
```

Banner at the top of every moved doc:

```markdown
> **Historical record (YYYY-MM-DD).** Describes the code as of that date.
> Current owner: [<module>](../../src/<module>/). Don't treat paths here as live.
```
