---
name: new-project
description: Set up a repo (JS/TS, Python, Rust or Go) so AI agents (and people) can navigate it fast and change it without whack-a-mole — rules file (AGENTS.md), architecture map, a generated codebase map the build keeps fresh (with module cycles), code-line size caps per file and per function (comments are free) with a shrink-only ratchet, a module-owner check so no module exists without a stated owner, a canonical-drift check that fails when a function or type is written again in another app or package of a monorepo, symbol-level references from the TypeScript compiler with multi-hop "what does this change reach" (and the tests to run), module seal and forbidden-dependency tests, a coupling classification that installs the right check for each kind of runtime coupling (registries, events, shared keys, persisted formats, parsed text, protocols), a doc-path checker, ADRs, and a history folder. Use when the user invokes /new-project, starts a new project/repo/app/service, asks to "set up the repo structure", "make the codebase easier for AI to navigate", "stop breaking things when we change stuff", or wants to bring an EXISTING repo up to this standard (retrofit mode — audit and report first). Also use before /app-build scaffolding so the structure exists from commit one.
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

# /new-project — Structure a repo so agents can find their way and can't silently break it

An agent working in an unfamiliar repo fails in two predictable ways:

1. **It trusts a doc that is wrong.** Stale paths and two guidance files that
   contradict each other send it down the wrong road with full confidence.
2. **It changes one end of a coupling it can't see.** Seven tables must all list
   a new tool, but only a prose checklist says so. One is missed, and the bug
   surfaces somewhere else days later. That's the whack-a-mole.

More documentation fixes neither. The fix is to give every kind of knowledge
exactly one home, and to make anything that can drift either *generated* or
*tested*:

| Layer | Answers | Home | Kept true by |
|---|---|---|---|
| Rules | what's allowed | `AGENTS.md` (+ short module guides) | review; kept short |
| Meaning | what owns what, how a request flows | `ARCHITECTURE.md` | doc-path check (doc → code), owner check (code → doc) |
| Facts | modules, importers, dependencies, cycles, oversized files | `docs/codebase-map.md` | generated; build fails when stale |
| Symbols | who uses this function, class, type or member | `refs` (TypeScript language service) | nothing stored; computed on demand |
| Couplings | "if X changes, Y must too", including the ones no import shows | tests, one per coupling kind (`references/couplings.md`) | the test suite |
| Decisions | why it's this way | `docs/adr/` | append-only |
| History | how it got here | `docs/history/` | not checked, clearly labeled |

The working rule behind all of it: **if a doc says "remember to also update X",
that sentence should be a failing test instead.**

## Pick the mode

- **New project** (empty repo, or a skeleton without established conventions)
  → follow *New project setup* below.
- **Existing codebase** → read `references/retrofit.md` and follow it. Audit,
  report ranked gaps, and change nothing until the user picks. Keep the repo's
  existing conventions; a physical-line size limit becomes code-line caps the
  user agrees to after measuring (`references/retrofit.md`).

If it's unclear which applies, the presence of real application code with
importers between modules means retrofit.

## New project setup

### 1. Establish the stack and layout

Find out (from the repo, or ask if there's nothing yet) the language, the source
root (default `src/`), the test runner, and the build/check command. Language
and framework are product choices, so ask rather than pick. Everything below is
an engineering default; decide it and move on.

The bundled scripts are Node (≥18) and understand JS/TS, Python, Rust and Go.
`scripts/project-languages.mjs` is the table they share, one row per language:
source extensions, the test-file rule, the import syntax, how an import
resolves to a file, the default source roots, and what a module is (a
top-level folder under the root for JS/TS and Python; a top-level folder or
`.rs` file under `src/` for Rust; a package directory for Go). Supporting
another language is adding a row. For a project that isn't Node, Node is a
dev-only dependency. If the user won't have Node at all, port the scripts;
each script's header states its contract.

Symbol-level references (`refs`) are TS/JS only, from the TypeScript
compiler. Rust and Go have their own: `cargo doc`/`rust-analyzer` and
`gopls` (`gopls references`) answer "who uses this function" there; point the
project's AGENTS.md at them instead of at `refs`.

### 2. Copy the tooling into the project

The project must own its checks, so they live in the project. Call
`project_kit` once: it writes these into the project folder, never overwriting
a file that exists, along with the AGENTS.md, ARCHITECTURE.md, ADR 0001 and
`docs/history/README.md` of step 4, and wires the npm scripts of step 3 when a
`package.json` is present:

| What `project_kit` writes | Purpose |
|---|---|
| `scripts/project-languages.mjs` | the language table (JS/TS, Python, Rust, Go) the map, the owner check, the doc-path check, the drift check and `check-structure` import; always copied with them |
| `scripts/codebase-map.mjs` | writes `docs/codebase-map.md` (modules, importers, dependencies, cycles); `--check` for build; `--deps <path>` for "who imports this module"; `--deps <path> --depth N` for who a change reaches hop by hop, plus the tests to run |
| `scripts/code-size.mjs`, `scripts/code-size-cfamily.mjs`, `scripts/code-size-python.mjs` | the code-line counter the size check and the map share: TS/JS through the TypeScript compiler API, found by `scripts/typescript-api.mjs` (approximate, without function sizes, when no TypeScript with that API is found), Python, Go and Rust through string- and comment-aware lexers; always copied with them |
| `scripts/check-code-size.mjs` | the size caps, in code lines: 400 per file and 100 per function by default (`--max-code`, `--warn-code`, `--max-fn`, `--warn-fn`), a warning band from 320 / 60 that never fails, and a shrink-only ratchet (`.code-size-ratchet`, `--write-ratchet`, `--tighten`). Its failure text steers to the design fix (move the job that grew into a module named after it) |
| `scripts/check-doc-paths.mjs` | fails when a live doc names a path that doesn't exist; build output (`dist/`, `build/`, `.next/` …) never counts as missing, and a framework creator's docs listed in `scripts/doc-paths-stock.json` (path → sha256) are skipped until edited |
| `scripts/check-module-owners.mjs` | fails when a module under a source root has neither its own AGENTS.md nor an ARCHITECTURE.md row |
| `scripts/check-canonical.mjs`, `scripts/canonical-drift.mjs` | canonical drift across source roots (a monorepo's apps, packages, functions): fails when a name the canonical root (`--canonical`, the shared package) exports is declared again elsewhere, or a name is exported from two other roots, i.e. one job implemented twice. Shrink-only ratchet (`.canonical-drift`, `--write-ratchet`, `--tighten`; a `# note` marks a pair that must exist). Also lists comments that admit a copy ("mirrors X", "keep in sync"). One root: nothing to compare, passes |
| `scripts/check-structure.mjs` | all of the above as one command (`--canonical` passes through to the map and the drift check); picks the source roots from the project kind when `--root` is not given, hands the map and the size check the same caps, and prints failing checks last so a reader of the tail sees them |
| `scripts/code-refs.mjs` | TS/JS only: `<Name>`, `<Class.member>`, `<file>#<Name>` → every use, by the compiler's resolution; `--depth N` → the declarations that use it, those that use them, N hops out, and the tests to run; `--duplicates` → exported names declared twice. Needs a TypeScript with the compiler API (TypeScript 5 or 6; `--typescript <dir>` points at one) |
| `scripts/refs-hint-hook.mjs` | not shipped here: a hook for another harness, and the kit installs no hooks |
| `assets/module-seals.test.ts` (vitest) or `assets/test_module_seals.py` (pytest) | seals (import only through the front door) and forbidden dependencies (never import X), both tables start empty |

`project_kit` puts the seal test where the test runner finds it. Each template has one
`SOURCE_ROOT` constant at the top, a path from the test file to the source
root: the TS one assumes it sits in the root (`.`; a Next app-dir project's
`app/`, Astro's `src/`), a SvelteKit test in `src/` points at `lib`, and the
Python one assumes `tests/` next to `src/` (`../src`). Rust and Go get no seal
test: the compiler enforces the boundary (`pub` visibility; Go's `internal/`
rule), so say that in AGENTS.md instead of shipping a test nothing needs.

### 3. Wire the checks into the build

The checks only work if they run without anyone remembering. For a Node project:

```json
"scripts": {
  "docs:map": "node scripts/codebase-map.mjs",
  "deps": "node scripts/codebase-map.mjs --deps",
  "refs": "node scripts/code-refs.mjs",
  "check:map": "node scripts/codebase-map.mjs --check",
  "check:size": "node scripts/check-code-size.mjs",
  "check:doc-paths": "node scripts/check-doc-paths.mjs",
  "check:owners": "node scripts/check-module-owners.mjs",
  "check:canonical": "node scripts/check-canonical.mjs",
  "check": "npm run check:size && npm run check:doc-paths && npm run check:owners && npm run check:canonical && npm run check:map && npm test",
  "build": "npm run check:size && npm run check:owners && npm run check:canonical && npm run check:map && <compile>"
}
```

`check:owners` is the discovery gate made mechanical: a new module can't land
until someone has written down what it owns and what it doesn't, which is the
moment a duplicate of an existing module gets noticed. `check:canonical` is
the same gate one level down: with several source roots, a function or type
can't be written a second time in another app without the build saying so.
Give it (and `docs:map`) the roots and `--canonical <shared package root>`;
a single-root project can leave it out. `refs` is on demand, never in the build.

What no script catches is one job built twice under different names and
shapes (two permission checks, two retry loops). That stays a judgment call:
`/canonical-check` before building, `/find-duplicate-systems` as a sweep.

`--depth N` on `deps` and `refs` answers "what does this change reach": hop 1
is the direct users, hop 2 their users, and the output ends with the tests to
run. That makes `/blast-radius`'s consumer list a command instead of a search.

The refs hint hook is not shipped here, so there is none to offer. Agents
reach for grep out of habit, and a grep for `hasCapability` misses
`import { hasCapability as can }` and matches every comment; put that reason,
and `npm run refs -- <Name>`, in the project's AGENTS.md instead.

Without `--root` the scripts take the source roots from the project file at
the repo root: `Cargo.toml` → `src`; `go.mod` → `internal/`, `cmd/`, `pkg/`
(those present); `package.json` → `src`, or the framework's own layout when
there is no `src/` (SvelteKit's `src/lib`, the `app/` dir of a Next
app-router or React Router (formerly Remix) project); `pyproject.toml` or nothing → `src`.
Pass `--root` (repeatable), the size caps or `--entry <module>` when that
doesn't fit: a Python `src/<package>/` layout keeps its modules one level
down (`--root src/<package>`, or the scripts see one module), and a flat Go
layout names its package folders explicitly.
`--entry` marks a module that is loaded at runtime rather than imported, so the
map doesn't call it dead. For Python, put the same commands in a Makefile, a
`pyproject` task runner, or pre-commit, whichever the project already uses. If
the repo has CI, add `check` to it. If it has none, offer to add a minimal
workflow rather than creating one unasked.

### 4. Write the docs

Use `references/templates.md`. Create:

- `AGENTS.md`: rules, commands, layout, the size rule (code-line caps, why,
  and the commit-naming rule below), coupling rules, growth rules. Under ~100 lines, because it loads into every session.
- `ARCHITECTURE.md`: read-these-first, request flow, subsystem table. For a
  brand-new project, fill in what exists and leave the table ready to grow. Don't
  invent subsystems that haven't been built.
- `docs/adr/0001-record-architecture-decisions.md`
- `docs/history/README.md`
- `docs/codebase-map.md`: generate it (`npm run docs:map`), never hand-write.

Fill in real commands and paths. A template placeholder left in a guidance doc
is a stale claim on day one.

### 5. Classify the couplings

The import graph shows one kind of coupling. The silent breakage comes from
the rest: an event name, a metadata key, a file format, a string one module
renders and another parses. Use `references/couplings.md` to find which kinds
this project has (or is about to have), and install the check for those kinds
only. A project with no event bus gets no event checker.

Registries come first if present: anything listed in more than one place
(tools, routes, permissions, providers, feature flags) becomes a single
declaration from the start (`references/registry-pattern.md`). That prevents the
most whack-a-mole of anything here. Record each kind's home and guard in
AGENTS.md's coupling section.

### 6. Prove the gates work

A check that never failed hasn't been tested. Run `check` and confirm it's
green, then prove each gate catches a real violation:

- Add a throwaway source file with 401 code lines → `check:size` fails, naming
  it; add 500 comment lines to a 330-line file → it passes with that file in the
  warning band (comments are free). A function with 101 own lines fails; the
  same lines split into an inner callback do not count toward the outer one.
- Put a backticked `src/does-not-exist.ts` in ARCHITECTURE.md → `check:doc-paths` fails.
- Add a module without regenerating the map → `check:map` fails.
- Add a module with no ARCHITECTURE.md row or AGENTS.md → `check:owners` fails.
- Several roots: export the same name from two non-canonical roots → `check:canonical`
  fails; declare a private copy of a canonical export → it fails as a shadow; a
  re-export (`export { x } from`) and a test file declaring the name pass.
- With one seal row, deep-import an internal → the seal test fails.
- With one forbidden-dependency row, import across it → that test fails.
- TS/JS: import a function under another name (`import { a as b }`), call `b()`,
  and run `refs a` → the call is listed (a text search for `a` would miss it).
- Chain three modules (`c` uses `b` uses `a`) with a test on `b`, then run
  `refs a --depth 2` and `deps <a's module> --depth 2` → both reach `c` and list
  `b`'s test.
- No hook probe: the refs hint hook is not shipped here.
- Rust (a scratch crate: `src/main.rs` with `mod auth; mod store;`,
  `src/auth.rs` using `crate::store::Db`, `src/store/mod.rs` + `db.rs`): the
  map lists `src/auth.rs` and `src/store/` with auth depending on store; with no
  row for `src/store/`, `check:owners` fails; a `src/big.rs` with 401 code lines
  fails `check:size`.
- Go (a scratch module: `go.mod`, `cmd/app/main.go` importing
  `<module>/internal/auth`, which imports `<module>/internal/store`): the map
  lists `cmd/app/`, `internal/auth/`, `internal/store/` and both edges, with
  `cmd/app/` as the entrypoint; with no row for `internal/store/`,
  `check:owners` fails; an `internal/auth/big.go` with 401 code lines fails `check:size`.

Revert every probe, re-run `check` green, and report each probe's outcome
honestly. If one didn't fail, the wiring is wrong. Fix it before finishing.

### 7. Hand off

Commit following the user's git conventions (never push unless asked). Then
tell the user what exists, which commands to run, and the growth rules now
written in AGENTS.md. The project doesn't depend on this skill to stay
healthy, because the rules live in the repo.

## The size rule: what it is for, and how it is met

The rule exists so an agent can navigate the repo and know where things are. A
file or function that does one job can be read whole in one pass, so the agent
edits with the full picture instead of a window. The cost runs the other way
too: dozens of 30-line files scatter one concept across many reads. So the goal
is **one responsibility per file and per function**, and the caps are the alarm
that one has started doing two jobs.

How it is counted, and why: only **code lines** count (a line holding a token
that is not a comment or whitespace). A rule that counts comment and blank lines
(about a third of a typical file) gets met by deleting documentation, which is
the opposite of navigable. Two caps, because a file cap alone does not stop
one function absorbing every new job:

| | cap | warning from | new-project default |
|---|---|---|---|
| file | code lines | `--warn-code` | 400 / 320 |
| function (its own lines; nested functions count for themselves) | code lines | `--warn-fn` | 100 / 60 |

Function sizes are measured for TS/JS (the TypeScript compiler API), Python
(`def`) and Go and Rust (`func` / `fn` bodies, by bracket matching over a lexer
that masks strings, chars and comments). TS/JS needs a `typescript` package that
exposes the compiler API: TypeScript 5 or 6. TypeScript 7's package (the native
compiler, which current Vite templates pin) exports only its version, so in such
a project pass `--typescript <dir of a TypeScript 5/6 package>` to
`check-structure.mjs` (or set `STRUCTURE_TYPESCRIPT`); a harness that runs a
project's check hands over its own copy this way. Without one, the check gets an
approximate file count and no function sizes, and says why; it never crashes.

How it must be met: near or over a cap, find the job that grew and move it into
a module (or function) named after that job. Never delete comments to fit, and
never name the split after the limit ("part 2", "helpers2", "under the 400-line
cap"). The same goes for commit subjects: name the commit after what moved and
why, never the size rule. A repo with git hooks can enforce that with a
`commit-msg` check; a built project gets the rule in its AGENTS.md instead, since
the kit installs no hooks. The warning band is listed in the check's output and
in the codebase map's "Nearing the size cap" section, so the split happens along
a seam before the cap forces one.

Existing repos: measure, then set caps with the user (`references/retrofit.md`);
what is already over is seeded into the ratchet once and only shrinks.

## Siblings

- `/canonical-check`: before building a subsystem, find the existing owner. `check:canonical` is its mechanical half: it catches a copy by name, the skill catches the copy under another name.
- `/find-duplicate-systems`: a sweep for parallel implementations of one concern; use it in a retrofit after `check-canonical --write-ratchet` has listed the name-level ones.
- `/blast-radius`: before changing a shared anchor. `npm run refs -- <Name> --depth 2` lists every declaration the change reaches and the tests to run; `npm run deps -- <path> --depth 2` does the same at file level.
- `/docs-sync`: bring an existing repo's docs back in line with the code.
- `/brownfield`: carry out retrofit gaps the user picked.
- `/app-build`: build a new app; run this skill first so the structure exists from commit one.
