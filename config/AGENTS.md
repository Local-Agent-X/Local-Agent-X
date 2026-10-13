# config/AGENTS.md — the product agent's own behavior

Everything here is the agent's own instructions, loaded into every chat. The
agent's file tools and shell may not write it, like the rest of the install
outside `workspace/`. The agent changes it only through `self_edit`, which runs
only in developer mode (Settings → Security, on a git-clone install); a
`self_edit` that touches a protected file here is held for the user to merge.
Without developer mode, the agent tells the user what change is needed.

## Files

| File | Owner | Hot-reload | Notes |
|---|---|---|---|
| `system-prompt.md` | user or `self_edit` (held for review) | yes | THE primary prompt: identity, how to work, personality. Split at its `## ` headings into budget classes (`src/config-loader.ts`); on small local models the `tuning` and `navigation` parts are shed first, `safety` and `identity` never. |
| `agent-rules.md` | user or `self_edit` (held for review) | yes (re-read every turn) | The short invariant list injected as a never-shed section. When it and the prompt differ, it wins. Keep it to what must always hold. |
| `protected-files.json` | user only | yes | Engine files the agent's file tools refuse; `self_edit` changes to one are held for review. Changing this list changes what `self_edit` is required for. |
| `model-profiles/*.json` | user | **no** — read once per process | Local-model capability profiles. |
| `app-manifest.json` | auto-generated, gitignored | n/a | Machine-readable catalog of pages, routes, tools, apps. Never hand-edit. Rewritten at startup and when `src/routes/`, `public/`, `workspace/apps/`, or `config/` changes. Only a summary of it (the App Map) reaches the prompt. |

## Invariants

- **No AI-vendor self-identification in `system-prompt.md`.** Identity is "you are running inside Local Agent X." Third-party services may be named.
- **Light theme is the default** in any behavioral config.
- **No embedded secrets.** `{{SECRET_NAME}}` placeholders; `http_request` resolves them from the vault.
- **Edits hot-reload.** `system-prompt.md`, `agent-rules.md` and `protected-files.json` take effect on the next turn with no restart or build. If an edit doesn't show, the watcher in `src/config-loader.ts` is the place to look.
- **Keep `system-prompt.md` lean.** It is measured in tokens, not lines (~15k today; lines average 150 characters). Every addition costs on every turn, and past a point agents skim.
- **Tool names in these files must exist.** `src/tools/tool-reference-coverage.test.ts` checks every backticked `snake_case` name against the registry.
