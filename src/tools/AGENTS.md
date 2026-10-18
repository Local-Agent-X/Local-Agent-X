# tools

**Owns:** Tool definitions (name, schema, description, `execute`) and the unified registry the model's schema is built from — which tools exist, which are eager vs deferred, and which audiences see them.
**Does not own:** Running a call (policy, Ari, approval, sandbox, audit) → `src/tool-execution/`; the per-tool policy row → `src/tool-policy/`; kernel classing → `src/ari-kernel/`.
**Entry:** `registry-build.ts` (`allTools`, `buildToolRegistry`) for core tools; `plugins.ts` registers everything else — the majority (`setting`, `http_request`, memory, browser, agents, protocols, apps, …); `registry.ts` (`unifiedRegistry`) is the one store; `runtime-tool-names.ts` builds the full runtime catalog for tests.

## Invariants
- A tool is reachable only if registered, and `allTools` is a minority: coverage tests must use `collectRuntimeToolNames()`, never `allTools` alone.
- `AUDIENCES_BY_TOOL` (`audience-map.ts`) is exhaustive: a tool absent from it is deferred — reachable only through `tool_search`. After editing it run `npm run docs:generated` (`docs/agent-capabilities.md` is generated from it and the build byte-compares).
- Registering a tool also means: a `src/tool-policy/` fragment entry (with `ariAction` if the kernel checks it), and on that row `reads` for every trusted stamp its body reads (path-gated tools get the session automatically); its row's `capabilities` (and `pathArgs`, if it opens paths) say which capability classes it belongs to, and its other facts (kill-switch, loop reading, prompt, companions, …) are row fields too — there are no lists to edit. How a call reads on the approval card is the tool's own `describeCall`.
- A path argument resolves through `resolveAgentPath(p, sessionIdOf(args))` — the session the file-access gate resolved it with — never a hand-rolled `resolve()` or a sessionless call (`src/tool-execution/agent-path-session.test.ts`).
- External content a tool returns is wrapped with `wrapExternalContent` (`src/sanitize.ts`) before it reaches the model.
- Every set of tools a role, kit, template, background job or surface gets is chosen by what the tools are for: the rows' `tags` (`src/tool-policy/tool-tags.ts`), through `selectTools` in `tool-kits.ts` (a tool the tags don't cover, or one they cover that the set must not hold, is a named exception with its reason) or `toolsTagged` in `src/tool-registry.ts`. The worker kits are named once in `tool-kits.ts`. Any literal collection naming two or more tools anywhere in `src/` or `scripts/` (an array, a record's keys, a switch, an `=== "x" ||` chain) is derived from the rows, registered in `tool-list-registry.test.ts` (a multi-name exception record, an outside format), or declared there not a tool list with why; the test finds every one in the syntax tree (`tool-name-collections.ts`) and checks each registered name against the runtime catalog.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `allTools` / `plugins.ts` | `src/tool-policy/` fragment, `src/tool-registry.ts` | `tool-registration-completeness.test.ts`, `src/tool-policy-default.test.ts` |
| `audience-map.ts` | `docs/agent-capabilities.md` (`npm run docs:generated`) | `tool-reference-coverage.test.ts` |
| a tool's `name` | every doc, prompt and table that names it | `tool-reference-coverage.test.ts`, `tool-list-registry.test.ts` |
| a row's `tags` (read by `tool-kits.ts` `selectTools` and `toolsTagged`) | every role (`src/agency/agent-roles.ts`), template (`src/agent-store/template-defaults.ts`), RBAC role (`src/rbac.ts`), worker kit, background job, the delegated worker belt (`src/ops/tools/delegated-toolset.ts`), the always-on helpers (`tool-search.ts`), the voice belt, the build-workflow routes and the keyword router (`src/agent-request/tool-filter.ts`) | `tool-kits.test.ts`, `src/agent-request/tool-filter.test.ts`, `src/ops/tools/delegated-toolset.test.ts`, `tool-registration-completeness.test.ts` |
| a row's `essentialRank` (`tier-tool-set.ts` `ESSENTIAL_TOOLS_ORDER`) | small-tier schemas | `src/model-tiers.test.ts`, `tool-registration-completeness.test.ts` |
| a row's `blurb` | `docs/agent-capabilities.md` (`npm run docs:generated`) | `check:generated-docs` |
| a row's `undo` (read by `undo-pairs.ts`) | `src/irreversible-tools.ts`, tool selection's `withUndoCounterparts` | `undo-pairs.test.ts`, `src/irreversible-tool-floor.test.ts` |
| a row's `companions` (read by `tool-companions.ts`) / `prompt` (read by `tool-prompt-builder.ts` `applyPrompts`) | the tier cap (`tier-tool-set.ts`), the system prompt's Tool Best Practices | `tool-companions.test.ts`, `tool-registration-completeness.test.ts` |

## Tests
`npx vitest run src/tools` (PowerShell on Windows)
