# app-scaffold

**Owns:** The structure kit a project built by the agent starts with — the guidance docs (AGENTS.md, ARCHITECTURE.md owner table, ADR 0001, docs/history), the vendored check scripts (`kit/`), the one command that runs them, and the package.json wiring.
**Does not own:** Where a project is created → `src/tools/framework-scaffold-run.ts` (Vite baseline), `src/auto-build/materialize.ts` (Product Build), `src/tools/build-app.ts` (other real tiers); the gates that run the check → `src/canonical-loop/adapters/app-build-verify-adapter.ts` (done-claim), `src/auto-build/chunk-review/gate-build-exec.ts` (chunk gate).
**Entry:** `project-kit.ts` — `projectKitFiles` (the files, for a staged writer), `applyProjectKit` (write + wire), `structureCheckCommand` (the gate's command, null without the kit).

## Invariants
- `kit/` is a copy of the /new-project skill's scripts and seal test, never hand-edited: `scripts/check-kit-sync.mjs` (`check:kit-sync` in the build) fails on a hash the manifest does not record and, when the skill is on this machine, on any difference from it. Change the skill, then `node scripts/check-kit-sync.mjs --sync`.
- `kit/` reaches `dist/` through `scripts/copy-bundled-assets.mjs`; `kit-files.ts` resolves it relative to itself, never `process.cwd()`.
- The kit never overwrites a file that exists and never runs on an existing tree uninvited: callers apply it where a project is created; a retrofit of an existing project is the same call, made on request.
- A doc the kit writes names only paths that exist when it is written (its own `check-doc-paths` would fail otherwise): the source root is named as a path only when it is present.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `STRUCTURE_CHECK_SCRIPT` / `STRUCTURE_CHECK_COMMAND` | the chunk gate's command list, the verify adapter's done gate, the build prompt line | `project-kit.test.ts`, `test/auto-build-chunk-review.test.ts` |
| the kit's file list (`projectKitFiles`) | Product Build's artifact queue must not collide with it (`spec/`, `scenarios/`, `twins/`, `README.md`) | `src/auto-build/materialize.test.ts` |
| a kit script's flags | `check-structure.mjs` forwards `--root` / `--max-loc` | the skill's probes; `project-kit.test.ts` runs the vendored copy |

## Tests
`npx vitest run src/app-scaffold` (PowerShell on Windows). The test runs the vendored scripts on a scratch project and proves each gate fails on its probe.
