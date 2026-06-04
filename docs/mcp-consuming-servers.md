# Consuming external MCP servers

LAX can consume any [Model Context Protocol](https://modelcontextprotocol.io/) server as a tool source. Each MCP server is a subprocess that exposes tools (and optionally resources/prompts); LAX's agent can call those tools alongside its native tool surface.

This doc covers the *consumption* side — LAX as MCP client. For exposing LAX's tools to other MCP clients (Cursor, Cline, Claude Desktop), see the separate `mcp-server-exposure.md` once that ships.

## Quick start — adding a server

Edit `~/.lax/mcp.json`. Each entry is one server:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:GITHUB_TOKEN}" },
      "disabled": false
    }
  }
}
```

The agent picks up the new tools on next config save (file watcher reloads automatically). Tools are namespaced as `mcp_<server>_<tool>`, e.g. `mcp_github_create_issue`. A server **named `filesystem`** is skipped entirely at connect time (the subprocess is never spawned) because LAX's native `read`/`write`/`edit`/`grep`/`glob` already cover that surface with full ARI/security integration. The skip is keyed on the server name, so a filesystem server configured under a different name would still connect and expose its tools.

## Placeholders — making one config work on every machine

Three forms are expanded at load time. **Nothing else is evaluated** — bare `$VAR`, `$(cmd)`, and backticks pass through as literal strings, so a tampered config can't smuggle shell substitution into a spawned subprocess.

| Placeholder | Resolves to |
|---|---|
| `${HOME}` | OS home directory (`os.homedir()`) |
| `${USERPROFILE}` | Windows home (`process.env.USERPROFILE` ?? `os.homedir()`) |
| `~/` (leading) | Same as `${HOME}/` |
| `${secret:NAME}` | Plaintext value from the encrypted secrets vault |

Use placeholders in `command`, any `args` element, or any `env` value. Multiple placeholders in one string expand independently.

This is the fix for the cross-machine-sync problem: a single `mcp.json` lives in `~/.lax/sync-repo/mcp.json` and resolves to the right paths on each machine.

## Secrets — never inline tokens

`mcp.json` is synced across machines. Inlining a real token there means the token gets committed to the sync repo and propagated to every machine you sync with. Always reference secrets via `${secret:NAME}`:

```json
"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:GITHUB_TOKEN}" }
```

Add the actual token to the vault via the secrets UI or the `secret_save` tool. The MCP manager reads it from the vault at spawn time and injects it into the server process's env. The plaintext value never enters the agent's prompt history and never lands in the synced config.

## Missing-secret behavior — skip-with-info, not warn

A server whose config references a `${secret:NAME}` that isn't in the vault is **skipped** at startup with an INFO log:

```
[mcp] Skipping "github" — missing secret(s): GITHUB_TOKEN. Add via secret_save or the secrets UI to enable.
```

Not a WARN. Missing tokens on a fresh install (or before you've configured an integration) is a normal state, and warning-spam trains operators to ignore the warning channel. Add the secret and the server will start on the next config-file save (or restart).

## External-content sanitization

Every MCP tool result is wrapped via `sanitize.wrapExternalContent(text, source: "mcp:<server-name>")` before reaching the agent. This:

- Surfaces an explicit warning to the model that the content came from a third-party process
- Strips known secret values (anything registered via `registerRedactedSecretValue`) from the body
- Detects and annotates likely prompt-injection patterns
- Neutralizes spoofed boundary markers and Unicode homoglyphs

Treat MCP-server output the same way LAX treats web fetches and document retrieval — useful as data, never as instructions.

## Hot-reload on config change

The MCP manager watches `~/.lax/mcp.json`. On save:

1. All current MCP server processes are disconnected.
2. The config is re-read and re-parsed.
3. Servers are re-spawned with newly-resolved placeholders.
4. New tools surface in the next agent turn's tool list.

A 250ms debounce coalesces editor save-events. No server restart required for: adding a server, removing a server, or flipping `disabled`. Saving a previously-missing secret to the vault does **not** auto-start a server that was skipped for it — re-save `mcp.json` (touch it) or restart LAX, since the watcher only watches the config file, not the vault.

## Troubleshooting

**Server starts then immediately exits.** Check stderr in the LAX log for the `[mcp:<name>]` prefix. Most common: command not found (npm package isn't installed and `npx` couldn't resolve it), or the server hit a runtime error parsing its env.

**`Failed to connect to <name>`.** The handshake (`initialize` then `tools/list`) timed out at 30s. The server is probably hanging on something — try running the same `command` + `args` manually in a terminal to see what it does.

**Tool not appearing in agent's tool list.** Confirm the server connected (look for `[mcp:<name>] Connected — N tools`). If the count is 0, the server didn't expose any tools. If non-zero but the agent doesn't pick them, the tool name might collide with a native one (LAX deduplicates by name).

**Secret IS in the vault but server is still skipped.** Names are case-sensitive and must match exactly. `${secret:GITHUB_TOKEN}` looks up `GITHUB_TOKEN`, not `github_token`. Verify the saved name in the Secrets panel (or with the `list_secrets` tool).

**Filesystem MCP tools missing on purpose.** A server named `filesystem` is skipped at connect time (never spawned) — LAX's native `read`/`write`/`edit`/`grep`/`glob` cover the same surface with full ARI policy and SecurityLayer path checking. The entry is fine to leave configured (its existence doesn't break anything), but its tools won't appear in the agent's surface unless you rename the server to something other than `filesystem`.

## Recommended servers to start with

These are well-maintained, broadly useful, and have low setup friction:

| Server | Capability | Required secret |
|---|---|---|
| `@modelcontextprotocol/server-github` | issues, PRs, repos, actions | `GITHUB_TOKEN` (PAT with appropriate scopes) |
| `@modelcontextprotocol/server-postgres` | SQL queries against a database | `POSTGRES_URL` (full connection string) |
| `@modelcontextprotocol/server-slack` | messages, channels, DMs | `SLACK_BOT_TOKEN` |
| `@modelcontextprotocol/server-filesystem` | scoped FS access (mostly redundant with native `read`/`write`) | none — uses path arg |
| `@modelcontextprotocol/server-puppeteer` | additional browser control surface | none |

The `mcp.json` template that ships with a fresh LAX install includes `filesystem`, `github`, and `postgres` entries with `disabled: true`. Flip `disabled` to `false` and add the matching secret to the vault to enable.

## Architecture notes

- **In-process tool execution stays the default for LAX-native tools.** ARI, type safety, and latency advantages matter too much to route the 170+ native tools through MCP. MCP is the *interop boundary*, not the *execution path*.
- **Per-call ARI evaluation still applies.** MCP tool calls go through the same ARI path as native calls. Because MCP tool names aren't in the `TOOLS` registry, the **autonomy risk tier** falls back to `shell` (the most conservative non-destructive tier; `src/autonomy/risk.ts`), and the **kernel classifier fail-closes** — unmapped tools are treated as an unaudited I/O surface and blocked unless explicitly classified (`src/ari-kernel/tool-class-map.ts`).
- **No automatic trust of new servers.** Servers must be explicitly listed in `mcp.json` with `disabled: false`. Auto-discovery is not implemented and not planned.
