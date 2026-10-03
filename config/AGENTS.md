# config/AGENTS.md — The agent's own behavior

Everything in this directory **hot-reloads** without a server restart. It is
the agent's own instructions, loaded into every chat, so the agent's file tools
and shell may not write it, like the rest of the install outside `workspace/`.
The agent changes it only through `self_edit`, which runs only in developer
mode — a switch only the user can turn on (Settings → Security, on a git-clone
install). Without it, the agent tells the user what change is needed.

## Files

| File | Owner | Hot-reload | Notes |
|---|---|---|---|
| `system-prompt.md` | user or `self_edit` | yes | THE primary prompt. Edit to change identity, rules, personality, available knowledge. |
| `tools.json` | user or `self_edit` | yes | Per-tool enable/disable, eager-load settings. Tool families also switch on and off through the `setting` tool. |
| `protected-files.json` | user only | yes | List of engine files only `self_edit` may change; a `self_edit` that changes one is held for the user's review before it merges. Only the user should modify this — changing it affects what `self_edit` is really "required" for. |
| `app-manifest.json` | auto-generated | n/a | Machine-readable catalog. Never hand-edit. Regenerates when `src/routes/`, `public/`, `workspace/apps/`, or `config/` changes. |

## Invariants

- **No AI-attribution text in `system-prompt.md`.** No "I'm Claude", no "powered by Anthropic", no vendor branding. Identity is "you are running inside Local Agent X."
- **No dark mode as default** in any behavioral config. Light unless user asks.
- **Don't embed secrets.** Use `{{SECRET_NAME}}` placeholders — server resolves from `secretsStore`.
- **`system-prompt.md` changes hot-reload immediately.** No restart, no build. If you edit it and don't see the change in the next turn, something is wrong with the watcher — use `self_edit` to debug.
- **Keep `system-prompt.md` under ~400 lines.** Past that, cache hit rate drops and agents start skimming rather than reading.
