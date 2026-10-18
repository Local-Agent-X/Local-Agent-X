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
| How far a change reaches, hop by hop, and the tests to run | `npm run refs -- <Name> --depth N` (declarations), `npm run deps -- <path> --depth N` (files) |
| Exported names declared in more than one file | `npm run refs -- --duplicates` |
| Regenerate `docs/agent-capabilities.md` after an audience change | `npm run docs:generated` |

Optional for Claude Code: `scripts/refs-hint-hook.mjs` is a PostToolUse hook
(matcher `Grep|Bash`) that, when you grep for a code symbol, suggests the
`refs` command for it. It never blocks; its header has the settings snippet.

## Directory boundaries

| Path | Committed | Rules |
|---|---|---|
| `src/` | yes | Core engine. One responsibility per module. The product agent reaches it only through `self_edit`. |
| `config/` | yes | The product agent's own behavior: `system-prompt.md`, `agent-rules.md`, `protected-files.json`, `model-profiles/`. Hot-reloads (model profiles are read once per process). |
| `public/` | yes | Shipped UI chrome, identical on every install. Never put a user page here. |
| `workspace/` | **no** | Per-machine user data: built apps, files. Served at `/apps/<name>/` from `workspace/apps/<name>/`. Never `rm -rf` in it. |
| `packages/arikernel/` | yes | Vendored security kernel. Hands off unless fixing a specific Ari bug. |
| `src/broker-transport/vendor/` | yes | The phone↔desktop wire contract, copied from agentxos. Never hand-edit: change agentxos, then `scripts/check-vendor-sync.mjs --sync` (`vendor/README.md`). |
| `desktop/src/contract/` | yes | The server↔desktop contract, copied from `src/desktop-contract/`. Never hand-edit: change the source, then `scripts/check-desktop-contract.mjs --sync`. |
| `src/app-scaffold/kit/` | yes | The structure kit dropped into every project the agent builds, copied from the `/new-project` skill. Never hand-edit: change the skill, then `scripts/check-kit-sync.mjs --sync`. |
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

- **Every model-initiated tool call goes through `src/tool-execution/`** (`executeToolCalls`, the one entry): Ari, policy, approval, RBAC, audit live there. Harness-initiated commands (build verification, spec probes, a built project's structure check) go through `executeHarnessCommand` in the same directory.
- **Mutating `/api/*` POSTs broadcast** `broadcastAll({ type: "settings_changed", ... })` so open tabs stay in sync. Checked per route by its tests, not globally.
- **External content enters the model through `wrapExternalContent()`** in `src/sanitize.ts`. Each network tool calls it itself.
- **Outbound HTTP from tools goes through `canonicalFetch` / `http_request`'s guard** (`src/tools/web-egress.ts`): DNS pinning, private-IP block, strict-mode allowlist, redirect re-check. Exceptions by protocol: IMAP (email), yt-dlp (youtube).
- **Secrets never appear in source, logs, or tool results.** `{{SECRET_NAME}}` placeholders are resolved only by `http_request`; the shell gets `secret_env`.
- **Default-deny tool policy.** A tool with no policy entry is blocked.

## Adding a tool

A tool is registered in more than one table. `npm run build` runs
`check:tool-registration` (`src/tools/tool-registration-completeness.test.ts`
over the runtime catalog, plugins included, plus `tool-reference-coverage.test.ts`
and `tool-list-registry.test.ts`): a tool with no policy entry or kernel class,
a name in a prompt or table that isn't a tool, or a new hand-kept list of tool
names that is neither derived from the policy rows nor registered, fails the
build. The other steps are covered by the tests named.

1. Define it under `src/tools/` and register it: `allTools` in `src/tools/registry-build.ts` for core file/retrieval tools, otherwise the owning plugin in `src/tools/plugins.ts` (memory, browser, secrets, agents, protocols, cron, apps, ...).
2. Policy entry in the matching `src/tool-policy/tool-policies.<domain>.ts` (`core`, `network`, `memory`, `orchestration`, `apps`, `globs`). `tool-policies.data.ts` only merges them. The entry's `kernel` class decides whether Ari checks the tool at all; `capabilities` (required) says which sink classes it belongs to (`egress`, `sensitive-read`, `shell`, or `[]`), and every gate keys on that, never on the name; `pathArgs` names the args file-confinement must check, and which paths a call writes, which is what puts it in the workspace-write class; `offBoxFetch: true` requires `egress` (`capability-class-gates.test.ts`). A tool that runs a model-written shell command declares `shellCommand: { arg }`, one whose result is off-box content declares `externalContent: true`, and `output` says what its result carries (`command-output-facts.test.ts`). A send declares `destination` (where it delivers); without one it reads as an unknown destination and is asked about every time.
3. `AUDIENCES_BY_TOOL` in `src/tools/audience-map.ts`, or the tool is deferred (reachable only by `tool_search`). Then `npm run docs:generated`.
4. A kernel-gated row (any `kernel` but `internal`) requires `ariAction`, the action the kernel judges a call as; it must be valid for the class (`exec` only for shell; `ari-action-map.test.ts`).
5. If destructive: the row's `risk: "destructive"` requires `undo` (the tool that reverses it, why it is recoverable, or why nothing can; the type will not build without it). A family with some destructive actions lists them in `destructiveActions`. If publish-shaped: the row's `publish` (`publish-operation.test.ts`).
6. If its body reads a trusted stamp (`sessionIdOf`, `operationIdOf`, `userMessageIdOf`, `lastTurnOf`, `cwdOf`): `reads` on the row (`session-scoped-tools.test.ts` scans every body; a tool with `pathArgs` gets the session without it). Every other fact about the tool is a row field too, each documented in `tool-policies.types.ts` with whether absence is a legal default or a declaration a test requires: `localArgs`, `runControl`, `committing`, `killSwitch`, `reach`, `loop`, `memoryWrite`, `category`, `hiddenFrom`, `transport`, `publish`, `prompt`, `companions`. Optional on the row: `timeoutMs` (fallback 120 s; 0 for a tool that runs for minutes) and `liveState` (`poll` / `fresh`, when an identical repeat can return something new). Optional on the tool: `compactDescription` for small models, `describeCall` for its line on the approval card.

## When in doubt

Ask the user. Don't guess at product, money, security, or taste calls.
