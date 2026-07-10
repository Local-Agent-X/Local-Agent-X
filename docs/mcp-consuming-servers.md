# Consuming external MCP servers

LAX can consume [Model Context Protocol](https://modelcontextprotocol.io/) servers as tool sources. An MCP server is third-party executable code, not a safe data feed: review its package, publisher, version, and requested access before enabling it.

This doc covers the *consumption* side — LAX as MCP client. For exposing LAX's tools to external MCP clients, see the separate `mcp-server-exposure.md` once that ships.

## Quick start — adding a server

The easiest path is the UI: **Settings → Tools & Integrations → MCP Servers**. Quick-add a known server, choose its execution posture, set any required vault secret, and enable/disable/test/remove it without touching a file. Changes apply to the agent's tool surface live — no restart.

You can also just **ask the agent** — "set up the GitHub MCP" — and it calls the `mcp_add_server` tool, prompting you for any required secret via `request_secret` before connecting. (Spawning a server is `shell`-risk, so it follows your autonomy profile: Safe asks first, Normal and looser run it like any `bash` call.)

To edit by hand instead, open `~/.lax/mcp.json`. Each entry is one server:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:GITHUB_TOKEN}" },
      "executionMode": "sandboxed",
      "disabled": false
    }
  }
}
```

The agent picks up the new tools on next config save (file watcher reloads automatically). Tools are namespaced as `mcp_<server>_<tool>`, e.g. `mcp_github_create_issue`. A server **named `filesystem`** is skipped entirely at connect time (the subprocess is never spawned) because LAX's native `read`/`write`/`edit`/`grep`/`glob` already cover that surface with full ARI/security integration. The skip is keyed on the server name, so a filesystem server configured under a different name would still connect and expose its tools.

## Child execution posture

`executionMode` is required by the API and UI. Direct configs that omit it default to `sandboxed`, never trusted. The field is synced configuration and is not an approval.

- `sandboxed` wraps the integrity-checked executable in the existing macOS seatbelt or Linux bubblewrap guarded profile. This is targeted confinement, not a full sandbox: it retains network and broad host filesystem access while denying selected credential paths and persistence writes.
- `trusted` requests a normal child process with the current user account's host permissions. It remains blocked until the authenticated user approves that exact command/args/env fingerprint in Settings. Approval lives only in `~/.lax/mcp-local-trust.json`, is not synced, and is invalidated by a config change.
- A valid signed manifest from a key in `~/.lax/trusted-publishers.json` can authorize its manifest-bound posture without local first-use approval. The signature binds the server name, release version, command identity, args/config fingerprint, publisher key, and `executionMode`.
- Windows currently has no supported MCP guarded child confinement. A `sandboxed` entry is blocked before integrity trust or spawn; trusted execution needs the separate local approval.

The agent-facing `mcp_add_server` tool cannot create or approve trusted execution. A synced or manually edited unsigned `executionMode: "trusted"` entry also cannot start through boot or the config watcher without matching local approval. Docker shell mode does not transparently containerize MCP servers because arbitrary host-installed MCP executables and their runtimes are not present in the shell image. Binary hash pinning, environment filtering, per-call policy, and output sanitization remain defense-in-depth controls; none makes an unreviewed server safe to run as trusted code.

### Signed publisher manifests

MCP uses the same raw Ed25519 publisher keys as plugins; there is no second trust root or incompatible signature scheme. A server config may include a `manifest`:

```json
{
  "command": "C:/tools/acme-mcp.exe",
  "args": ["--stdio"],
  "executionMode": "trusted",
  "manifest": {
    "schemaVersion": 1,
    "serverName": "acme",
    "version": "2.1.0",
    "publisher": "acme",
    "keyId": "release-2026",
    "command": {
      "kind": "binary",
      "resolvedPath": "C:/tools/acme-mcp.exe",
      "sha256": "<sha256 from the MCP integrity hasher>"
    },
    "configFingerprint": "<sha256 of canonical command/args/env config>",
    "executionMode": "trusted",
    "signature": "<hex Ed25519 signature>"
  }
}
```

Package manifests can use `{"kind":"package","manager":"npx","managerPath":"C:/Program Files/nodejs/npx.cmd","managerSha256":"<sha256>","name":"@acme/mcp","version":"2.1.0"}` instead. The configured package argument must be exactly `@acme/mcp@2.1.0`; unpinned package names do not satisfy a signed package identity. `managerPath` is the canonical real path of the resolved package-manager executable and `managerSha256` uses the existing MCP integrity hasher. Both are signed and checked before publisher trust, and LAX spawns the canonical signed target so package-manager replacement, PATH drift, or symlink retargeting fails closed.

Because exact executable identity is host-specific, publishers should issue package manifests for each supported platform/package-manager build or operators should use a locally generated publisher manifest. The package name, package version, full command/args/env fingerprint, and execution posture remain independently bound by the same signature.

The signature is over UTF-8 JSON with fields in this order: `schemaVersion`, `serverName`, `version`, `publisher`, optional `keyId`, normalized `command`, lowercase `configFingerprint`, and `executionMode`. `mcpManifestPayload()` and `mcpConfigFingerprint()` in `src/mcp-client/manifest.ts` are the canonical publisher helpers.

Trusted publishers are configured in the existing local store. The legacy single-key form remains supported; named keys enable rotation:

```json
{
  "acme": {
    "name": "ACME Tools",
    "publicKeys": {
      "release-2026": "<64 hex chars>",
      "release-2027": "<64 hex chars>"
    }
  }
}
```

Remove a retired key from `publicKeys` after its overlap window. Unknown publishers are not publisher-verified and may run only guarded or with explicit machine-local trust. An unknown key ID for a known publisher, a bad signature, binary/args/config/posture tampering, or a malformed manifest fails closed in every posture.

Accepted signed releases are recorded in local `~/.lax/mcp-signed-manifests.json`. A valid higher semantic version advances the record. Lower versions, different manifests reusing an accepted version, removing the manifest, and losing the previously accepted publisher trust are blocked. This prevents downgrade, same-version replay, and signature stripping after an upgrade.

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

This is **enforced, not just advised**. The child-env builder strips credential-shaped env keys (anything matching `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, …) by default, so a raw token you inline in `env` is dropped before the server ever starts — the server then fails to authenticate, which is the signal to switch to `${secret:...}`. A value that resolved from a `${secret:NAME}` placeholder is exempt from that strip (it's the legitimate, vault-sourced injection channel), so only the vault path actually reaches the server. Credentials from the host's own environment (your `ANTHROPIC_API_KEY`, etc.) are never passed to MCP children regardless.

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

These are common examples, not a security endorsement. Verify current ownership, maintenance, and package contents before installation:

| Server | Capability | Required secret |
|---|---|---|
| `@modelcontextprotocol/server-github` | issues, PRs, repos, actions | `GITHUB_TOKEN` (PAT with appropriate scopes) |
| `@modelcontextprotocol/server-postgres` | SQL queries against a database | `POSTGRES_URL` (full connection string) |
| `@modelcontextprotocol/server-slack` | messages, channels, DMs | `SLACK_BOT_TOKEN` |
| `@modelcontextprotocol/server-filesystem` | scoped FS access (mostly redundant with native `read`/`write`) | none — uses path arg |
| `@modelcontextprotocol/server-puppeteer` | additional browser control surface | none |

The `mcp.json` template that ships with a fresh LAX install includes `github` and `postgres` entries with `disabled: true` and `executionMode: "sandboxed"`. Add the matching secret to the vault and enable the entry when ready.

## Architecture notes

- **In-process tool execution stays the default for LAX-native tools.** ARI, type safety, and latency advantages matter too much to route the 170+ native tools through MCP. MCP is the *interop boundary*, not the *execution path*.
- **Per-call ARI evaluation still applies.** MCP tool calls go through the same ARI path as native calls. Because MCP tool names aren't in the `TOOLS` registry, the **autonomy risk tier** falls back to `shell` (the most conservative non-destructive tier; `src/autonomy/risk.ts`), and the **kernel classifier fail-closes** — unmapped tools are treated as an unaudited I/O surface and blocked unless explicitly classified (`src/ari-kernel/tool-class-map.ts`).
- **No automatic trust of new servers.** Servers must be explicitly listed in `mcp.json` with `disabled: false`. Auto-discovery is not implemented and not planned.
