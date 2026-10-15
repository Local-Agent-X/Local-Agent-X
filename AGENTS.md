# AGENTS.md — rules for anyone changing this repo

For coding agents (Codex, Claude Code, `self_edit`) and people working ON the
codebase. The in-product Local Agent X agent does not read this file; its
runtime invariants are `config/agent-rules.md`, beside its prompt.

Read first: [ARCHITECTURE.md](ARCHITECTURE.md) (which code owns what) and
[docs/codebase-map.md](docs/codebase-map.md) (generated: modules, importers,
oversized files). When a number in prose disagrees with the map, the map wins.

## Commands

| Task | Command |
|---|---|
| Build, with every static check in front of it | `npm run build` |
| Unit tests (vitest; use PowerShell on Windows) | `npm run test:unit` |
| Regenerate the codebase map after adding or moving a module | `npm run docs:map` |
| Who imports a file or module, file by file | `npm run deps -- <path>` |
| Who uses a function, class, type or member (the compiler's answer, via `src/language-intel/`) | `npm run refs -- <Name>` (or `<file>#<Name>`, `<file>:<line>`) |
| Exported names declared in more than one file | `npm run refs -- --duplicates` |
| Regenerate `docs/agent-capabilities.md` after an audience change | `npm run docs:generated` |

## Directory boundaries

| Path | Committed | Rules |
|---|---|---|
| `src/` | yes | Core engine. One responsibility per module. The product agent reaches it only through `self_edit`. |
| `config/` | yes | The product agent's own behavior: `system-prompt.md`, `agent-rules.md`, `protected-files.json`, `model-profiles/`. Hot-reloads (model profiles are read once per process). |
| `public/` | yes | Shipped UI chrome, identical on every install. Never put a user page here. |
| `workspace/` | **no** | Per-machine user data: built apps, files. Served at `/apps/<name>/` from `workspace/apps/<name>/`. Never `rm -rf` in it. |
| `packages/arikernel/` | yes | Vendored security kernel. Hands off unless fixing a specific Ari bug. |
| `src/broker-transport/vendor/` | yes | The phone↔desktop wire contract, copied from agentxos. Never hand-edit: change agentxos, then `scripts/check-vendor-sync.mjs --sync` (`vendor/README.md`). |
| `dist/` | no | Build output. Never hand-edit. |

A user page ("build me a calendar") is `workspace/apps/calendar/index.html`
pinned at `/apps/calendar/`, not `public/calendar.html`. <!-- doc-paths:ignore -->

## Code rules (checked by `npm run build`)

- **No source file over 400 lines** (`check:source-hygiene`; tests exempt). Split by responsibility before a file gets there.
- **No `require()`**; the package is ESM (`check:no-require`). Import source with the `.js` suffix; never import from `dist/`.
- **The codebase map must be current** (`check:codebase-map`).
- **Every path named in a current doc exists** (`check:doc-paths` over `scripts/current-docs.mjs`). Add a doc to that list when agents are pointed at it; move finished plans to `docs/history/`.
- **Every module under `src/` has an owner on record** (`check:module-owners`): its own `AGENTS.md`, or a row in ARCHITECTURE.md's subsystem map saying what it owns and what it doesn't. A new module needs one before the build passes; that row is where a duplicate of an existing module gets noticed.

## Code rules (checked by review)

- **Read before edit.** Never change code you haven't opened.
- **Extend the owner.** Find the module that owns the concern (ARCHITECTURE.md) before writing a new one, and run `npm run refs -- <Name>` for the name you'd give a new function. No parallel implementations, no compat shims for removed features.
- **Keep the diff on the task.** No comments, types, or cleanups in code you didn't need to touch. No error handling for cases that can't happen.
- **No AI-vendor or tool attribution in code comments.** It belongs in commit metadata.
- **Light theme is the default.**
- **Tests ship with behavior.** Colocated `*.test.ts`; contract tests for cross-module seams.

## Runtime invariants (what the code must keep true)

- **Every model-initiated tool call goes through `src/tool-execution/`** (`executeToolCalls` / `dispatchSingleToolCall`): Ari, policy, approval, RBAC, audit live there. Harness-initiated commands (build verification, spec probes) go through `executeHarnessCommand` in the same directory.
- **Mutating `/api/*` POSTs broadcast** `broadcastAll({ type: "settings_changed", ... })` so open tabs stay in sync. Checked per route by its tests, not globally.
- **External content enters the model through `wrapExternalContent()`** in `src/sanitize.ts`. Each network tool calls it itself.
- **Outbound HTTP from tools goes through `canonicalFetch` / `http_request`'s guard** (`src/tools/web-egress.ts`): DNS pinning, private-IP block, strict-mode allowlist, redirect re-check. Exceptions by protocol: IMAP (email), yt-dlp (youtube).
- **Secrets never appear in source, logs, or tool results.** `{{SECRET_NAME}}` placeholders are resolved only by `http_request`; the shell gets `secret_env`.
- **Default-deny tool policy.** A tool with no policy entry is blocked.

## Adding a tool

A tool is registered in more than one table, and most of the tables are
hand-maintained. `npm run build` runs `check:tool-registration`
(`src/tools/tool-registration-completeness.test.ts` over the runtime catalog,
plugins included, plus `tool-reference-coverage.test.ts`): a tool with no
policy entry or kernel class, or a name in a prompt or table that isn't a
tool, fails the build. The other steps are covered by the tests named.

1. Define it under `src/tools/` and register it: `allTools` in `src/tools/registry-build.ts` for core file/retrieval tools, otherwise the owning plugin in `src/tools/plugins.ts` (memory, browser, secrets, agents, protocols, cron, apps, ...).
2. Policy entry in the matching `src/tool-policy/tool-policies.<domain>.ts` (`core`, `network`, `memory`, `orchestration`, `apps`, `globs`). `tool-policies.data.ts` only merges them. The entry's `kernel` class decides whether Ari checks the tool at all; `pathArgs` names the args file-confinement must check; `offBoxFetch: true` must be mirrored in `EGRESS_TOOLS` (`capability-class-gates.test.ts`).
3. `AUDIENCES_BY_TOOL` in `src/tools/audience-map.ts`, or the tool is deferred (reachable only by `tool_search`). Then `npm run docs:generated`.
4. `ARI_ACTION_MAP` in `src/tool-execution/ari-action-map.ts` for `file` / `http` / `retrieval` kernel classes (`ari-action-map.test.ts`).
5. Capability sets in `src/tool-registry.ts` as applicable: `EGRESS_TOOLS`, `SENSITIVE_READ_TOOLS`, `WORKSPACE_WRITE_TOOLS`, `SHELL_TOOLS`.
6. If destructive: `src/tools/undo-pairs.ts` and `src/irreversible-tools.ts`. If publish-shaped: `src/publish-operation.ts`.
7. If it reads `_sessionId`: `SESSION_SCOPED_TOOLS` in `src/tool-execution/resolve-tool.ts`. Optional: `DEFAULT_TIMEOUTS` in `tool-timeout.ts` (fallback 120 s), `compactDescription` for small models.

## When in doubt

Ask the user. Don't guess at product, money, security, or taste calls.
