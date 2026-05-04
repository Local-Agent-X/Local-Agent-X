# config/AGENTS.md — Agent-editable behavior

Everything in this directory is **safe to edit** and **hot-reloads** without a
server restart. This is where the agent tunes its own behavior without touching
core engine code.

## Files

| File | Owner | Hot-reload | Notes |
|---|---|---|---|
| `system-prompt.md` | agent or user | yes | THE primary prompt. Edit to change identity, rules, personality, available knowledge. |
| `tools.json` | agent or user | yes | Per-tool enable/disable, eager-load settings. |
| `protected-files.json` | user only | yes | List of `src/` files that BLOCK direct `edit`/`write`. Only the user should modify this — changing it affects what `self_edit` is really "required" for. |
| `app-manifest.json` | auto-generated | n/a | Machine-readable catalog. Never hand-edit. Regenerates when `src/routes/`, `public/`, `workspace/apps/`, or `config/` changes. |

## Invariants

- **No AI-attribution text in `system-prompt.md`.** No "I'm Claude", no "powered by Anthropic", no vendor branding. Identity is "you are running inside Local Agent X."
- **No dark mode as default** in any behavioral config. Light unless user asks.
- **Don't embed secrets.** Use `{{SECRET_NAME}}` placeholders — server resolves from `secretsStore`.
- **`system-prompt.md` changes hot-reload immediately.** No restart, no build. If you edit it and don't see the change in the next turn, something is wrong with the watcher — use `self_edit` to debug.
- **Keep `system-prompt.md` under ~400 lines.** Past that, cache hit rate drops and agents start skimming rather than reading.
