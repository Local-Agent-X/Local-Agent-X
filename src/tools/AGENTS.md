# tools

**Owns:** Tool definitions (name, schema, description, `execute`) and the unified registry the model's schema is built from — which tools exist, which are eager vs deferred, and which audiences see them.
**Does not own:** Running a call (policy, Ari, approval, sandbox, audit) → `src/tool-execution/`; the per-tool policy row → `src/tool-policy/`; kernel classing → `src/ari-kernel/`.
**Entry:** `registry-build.ts` (`allTools`, `buildToolRegistry`) for core tools; `plugins.ts` registers everything else — the majority (`setting`, `http_request`, memory, browser, agents, protocols, apps, …); `registry.ts` (`unifiedRegistry`) is the one store; `runtime-tool-names.ts` builds the full runtime catalog for tests.

## Invariants
- A tool is reachable only if registered, and `allTools` is a minority: coverage tests must use `collectRuntimeToolNames()`, never `allTools` alone.
- `AUDIENCES_BY_TOOL` (`audience-map.ts`) is exhaustive: a tool absent from it is deferred — reachable only through `tool_search`. After editing it run `npm run docs:generated` (`docs/agent-capabilities.md` is generated from it and the build byte-compares).
- Registering a tool also means: a `src/tool-policy/` fragment entry (with `ariAction` if the kernel checks it), `SESSION_SCOPED_TOOLS` if it reads `_sessionId` outside its policy `pathArgs` (path-gated tools are stamped automatically); its row's `capabilities` (and `pathArgs`, if it opens paths) say which capability classes it belongs to — there are no class lists to edit.
- A path argument resolves through `resolveAgentPath(p, sessionIdOf(args))` — the session the file-access gate resolved it with — never a hand-rolled `resolve()` or a sessionless call (`src/tool-execution/agent-path-session.test.ts`).
- External content a tool returns is wrapped with `wrapExternalContent` (`src/sanitize.ts`) before it reaches the model.
- A literal collection of tool names anywhere in `src/` or `scripts/` (an array, a record's keys, a switch, an `=== "x" ||` chain) is either derived from the policy rows or registered in `tool-list-registry.test.ts`, which finds every one in the syntax tree (`tool-name-collections.ts`) and checks each name against the runtime catalog. The shared kits (`tool-kits.ts`) are the one place a worker's tool set is spelled out.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `allTools` / `plugins.ts` | `src/tool-policy/` fragment, `src/tool-registry.ts` | `tool-registration-completeness.test.ts`, `src/tool-policy-default.test.ts` |
| `audience-map.ts` | `docs/agent-capabilities.md` (`npm run docs:generated`) | `tool-reference-coverage.test.ts` |
| a tool's `name` | every doc, prompt and table that names it | `tool-reference-coverage.test.ts`, `tool-list-registry.test.ts` |
| `tier-tool-set.ts` (`ESSENTIAL_TOOLS_ORDER`) | small-tier schemas | `src/model-tiers.test.ts` |
| a row's `undo` (read by `undo-pairs.ts`) | `src/irreversible-tools.ts`, tool selection's `withUndoCounterparts` | `undo-pairs.test.ts`, `src/irreversible-tool-floor.test.ts` |

## Tests
`npx vitest run src/tools` (PowerShell on Windows)
