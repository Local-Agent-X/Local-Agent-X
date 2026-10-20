# app-scaffold

**Owns:** The structure kit a project built by the agent starts with — the guidance docs (AGENTS.md, ARCHITECTURE.md owner table, ADR 0001, docs/history), the vendored check scripts and seal tests (`kit/`), the one command that runs them, the package.json wiring, and the reading of the project kind on disk (`project-kind.ts`) that decides what the kit writes.
**Does not own:** Where a project is created → `src/tools/framework-scaffold-run.ts` (Vite baseline), `src/auto-build/materialize.ts` (Product Build), `src/tools/build-app.ts` (other real tiers); the gates that run the check → `src/canonical-loop/adapters/app-build-structure-gate.ts` (done-claim, which also adopts the kit for a new build's self-scaffolded project), `src/auto-build/chunk-review/gate-build-exec.ts` (chunk gate); the command that verifies a project → `src/agent-guards/build-command.ts`.
**Entry:** `project-kit.ts` — `projectKitFiles` (the files, for a staged writer), `applyProjectKit` (write + wire), `adoptProjectKit` (the kit for a project someone else created, once), `structureCheckCommand` (the gate's command, null without the kit), `structureWarningNote` (`structure-check-output.ts`: what a passing check said is nearing a size cap, as the gates' note for the agent's next turn).

## Invariants
- `kit/` is a copy of the /new-project skill's scripts and seal tests, never hand-edited: `scripts/check-kit-sync.mjs` (`check:kit-sync` in the build) fails on a hash the manifest does not record and, when the skill is on this machine, on any difference from it. Change the skill, then `node scripts/check-kit-sync.mjs --sync`.
- `kit/` reaches `dist/` through `scripts/copy-bundled-assets.mjs`; `kit-files.ts` resolves it relative to itself, never `process.cwd()`.
- Each fact about the kit lives once. Which scripts it has: `scripts/check-kit-sync.mjs` `KIT_FILES`, read back from `kit/UPSTREAM.json` (`kit-files.ts` `KIT_SCRIPTS`). The size rule, counting and caps: `kit/code-size.mjs`, used in this process through `kit-size.ts` (the prompts' numbers, the autopilot's round gate). Never restate either.
- The kit never overwrites a file that exists and never runs on an existing app uninvited: callers apply it where a project is created, or adopt it once at a new build's first done-claim; a retrofit of an existing project is the same call, made on request.
- A doc the kit writes names only paths that exist when it is written (its own `check-doc-paths` would fail otherwise): a source root is named as a path only when it is present.
- The docs a project came with (a framework creator's README) are recorded on the kit's first landing in `scripts/doc-paths-stock.json` (`creator-docs.ts`, the only writer); the kit's `check-doc-paths` skips one while its hash matches. The record's format is the kit script's header; `project-kit.test.ts` runs the vendored check on a record this module wrote. <!-- doc-paths:ignore: a path in the built project, not here -->
- The root rule in `project-kind.ts` restates the kit script's own (`kit/project-languages.mjs`, `defaultRoots`); `project-kind.test.ts` runs the script on the same fixtures, so the docs and the checks always name the same folders.
- This repo's own size rule runs the kit's size check (`scripts/check-source-hygiene.mjs`), and its map uses the kit's counter: one implementation of "code lines" for LAX and every project it builds.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `STRUCTURE_CHECK_SCRIPT` / `STRUCTURE_CHECK_COMMAND` | the chunk gate's command list, the verify adapter's done gate, the build prompt lines | `project-kit.test.ts`, `test/auto-build-chunk-review.test.ts` |
| the kit's file list (`projectKitFiles`) | Product Build's artifact queue must not collide with it (`spec/`, `scenarios/`, `twins/`, `README.md`) | `src/auto-build/materialize.test.ts` |
| the stock-docs record (`STOCK_DOCS_MANIFEST`, `stockDocHash`) | the kit's `check-doc-paths.mjs` reads it beside itself | `project-kit.test.ts` (the doc-path describes) |
| a kit script's flags or its root rule | `check-structure.mjs` forwards `--root` and the size caps (`--max-code` / `--warn-code` / `--max-fn` / `--warn-fn`, `--ratchet`); `project-kind.ts`; `scripts/check-source-hygiene.mjs` and `scripts/gen-codebase-map.mjs`, which run this repo's own size rule through `kit/check-code-size.mjs` and `kit/code-size.mjs` | the skill's probes; `project-kit.test.ts` runs the vendored copy; `project-kind.test.ts`; `test/source-hygiene-gate.test.ts` |
| the kit's code-line counter (`kit/code-size*.mjs`) | every project's size check and map, and this repo's | `kit-code-size.test.ts` (tricky inputs per language), `kit-size-ratchet.test.ts` |
| the size check's warning block (heading, item line shape) | `structure-check-output.ts` parses it into the gates' note | `structure-check-output.test.ts` runs the vendored script |
| `KIT_SIZE_CAPS` (`kit-files.ts`) | the kit's `DEFAULT_LIMITS` (`kit/code-size.mjs`); the AGENTS.md template and the build prompt lines | `project-kit.test.ts` (the 401-line probe) |
| the Vite plan's test runner (`viteScaffoldPlan`) | the seal test ships only with a runner; `wireNpmScripts` adds `test` | `test/framework-scaffold-plan.test.ts`, `project-kit.test.ts` |

## Tests
`npx vitest run src/app-scaffold` (PowerShell on Windows). The tests run the vendored scripts on scratch TypeScript, Python, Rust, Go and Next projects and prove each gate fails on its probe. `npm run test:scaffold-live` (gated, minutes, network) runs every framework's real creator and then the kit.
