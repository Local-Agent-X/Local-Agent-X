# Foundation: repo structure and its checks

A new app has no conventions, so the first agents to arrive invent them, each
differently. This phase gives the repo its rules, its map and the build checks
that keep both true, before the first feature lands. Read it at phase 6.

The reasoning behind every piece is in `/new-project`. This file is the order
of work for a project that is being built from a spec.

## The kit

The checks are scripts the project owns (CI and other machines cannot reach
LAX). `project_kit` writes them into the project, with the seal test and the
starting AGENTS.md and ARCHITECTURE.md, never overwriting a file that exists.
The templates and coupling guides are the `/new-project` protocol's own files:
`protocol` (action `get`, name `new-project`, file `references/templates.md`,
`references/couplings.md` or `references/registry-pattern.md`).

Read the `/new-project` protocol, section "New project setup", for the script
table, the `package.json` wiring and the per-language notes. Do not restate
them from memory; that protocol is the source.

## Order of work

1. **Create the stack.** The folder is already a repository holding `spec/`
   (phase 2). Run the framework's own creator if it has one and set up the test
   runner. The stack was decided in `spec/architecture.md`; do not re-ask.
2. **Add the kit** with `project_kit`; it puts the seal test where the test
   runner finds it. The kit reads JS/TS, Python, Rust, Go, Kotlin, Java, Swift, C#,
   C/C++ and Dart; only JS/TS and Python get a seal test, and for the rest
   AGENTS.md names what holds the boundary (`/new-project` step 2: the
   compiler's `internal`, a Gradle module, a Swift target, a .NET project).
   Lay the project out the way the build tool expects (`src/main/kotlin`,
   `Sources/<Target>`, `src/<Project>/`, `src` + `include`, `lib/`), so the
   checks find their roots without flags.
3. **Wire the checks into the build**, so they run without anyone remembering:
   `check`, `build`, `docs:map`, `deps`, `refs` as `/new-project` step 3 shows.
   A project that isn't Node keeps Node as a dev-only tool and runs
   `node scripts/check-structure.mjs` from its build tool's check step (Gradle,
   MSBuild, SwiftPM/Xcode, CMake, Dart) and from CI.
4. **Write the docs** from the `/new-project` protocol's `references/templates.md`:
   - `AGENTS.md`: rules, commands, layout, the size rule, coupling and growth
     rules. Under ~100 lines. Add the project's constitution rules that govern
     code, and one line saying the scenario suite is sealed and builders work
     from `spec/`.
   - `ARCHITECTURE.md`: seeded from `spec/architecture.md`, listing only what
     exists. It grows a row per module as chunks land; the owner check fails
     the build until a new module has one.
   - `docs/adr/0001-record-architecture-decisions.md`, plus an ADR for each
     real choice the interview settled (the stack, the identity key, the tier).
   - `docs/history/README.md`.
   - `docs/codebase-map.md`: generated, never hand-written.
   - `README.md`: what the app is and how to install, run and check it, as
     exact commands. Write it so the whole block can be pasted to an agent and
     followed without a person filling in steps.
5. **Build the skeleton** (the scaffold chunk): directory structure, shared
   types, the router or registry, the data layer, the contracts features plug
   into. One owner, serial, `/senior-engineer` discipline. This is the most
   consequential chunk: it creates every seam the features will use, and two
   agents scaffolding at once produce two incompatible skeletons.
6. **Classify the couplings** the skeleton introduced
   (the `/new-project` protocol's `references/couplings.md`): anything listed in more than one
   place becomes a single declaration now (the protocol's `references/registry-pattern.md`),
   and each kind of coupling present gets its test. If a doc would say
   "remember to also update X", write the failing test instead.
7. **Prove the gates work.** Run `check` green, then make each gate fail on a
   real violation (an oversized file, a doc naming a missing path, a module
   with no owner row, a stale map, a deep import past a seal) and revert every
   probe. The full probe list is `/new-project` step 6. A check that has never
   failed has not been tested.
8. **Write `.lax-launch.json`** at the project root: `{"start": "<the dev
   command>", "ready_url": "<the URL that answers when it is up>"}`. The judge
   starts the app from it; without it nothing can be scored.
9. **Commit.** From here the app is brownfield-shaped: it has seams, owners and
   checks, and feature chunks extend them.

## What the checks buy during the build

They are the mechanical half of the code-quality gate. While chunks land:

- a file or function that has started doing two jobs trips the size cap;
- a second copy of an exported name trips the canonical-drift check;
- a module nobody has described cannot land;
- a doc that names a path that no longer exists fails the build.

What no script catches is one job built twice under different names. That is
the judgment half: `/canonical-check` in every chunk brief, and the sweep at
the finish gates.

## Existing repos

This phase is for a new project. Bringing an existing codebase up to this
standard is `/new-project` in retrofit mode: audit, report, change only what
the owner picks.
