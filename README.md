# Local Agent X

A self-hosted personal agent platform. Runs entirely on your machine — your files, your keys, your conversations. Speaks multiple LLM providers (Anthropic, OpenAI, Codex CLI, xAI Grok, Google Gemini, Cerebras, Ollama), so you're not locked into one vendor's pricing or availability.

Beyond chat, it ships voice (push-to-talk and full-duplex), scheduled missions on cron, a tool-executor with a default-deny policy, and a workspace where the agent builds and serves its own small apps. The runtime UI is a single HTTP server you open in any browser. Self-modification routes through a `config/` directory that hot-reloads; deeper changes go through a `self_edit` tool wired into the runtime.

It's research-grade software, not a polished product. Active development — see [Status](#status) for the current refactor.

## System requirements

- **OS**: Windows 10/11, macOS (Apple Silicon or Intel), Debian/Ubuntu Linux.
- **RAM**: 8 GB minimum, 16 GB recommended (Ollama + Chromium + the runtime are each non-trivial).
- **Network**: ~2.5–3.5 GB of one-time downloads during install (Node, Ollama, the embedding model, npm packages, plus Visual Studio Build Tools on Windows).

The install scripts fetch everything below if it's missing — you don't have to install Node or Ollama yourself. The totals are what to expect end-to-end.

| What gets installed | Windows | macOS |
|---|---|---|
| Local Agent X source (extracted) | 280 MB | 280 MB |
| Node.js 22 LTS | ~150 MB | ~150 MB |
| Python 3.12 | ~100 MB | (usually preinstalled) |
| Ollama runtime | ~600 MB | ~500 MB |
| Ollama embedding model (`mxbai-embed-large`) | 670 MB | 670 MB |
| C++ toolchain: Visual Studio Build Tools (Win) / Xcode Command Line Tools (Mac) | ~3 GB | ~1 GB |
| `npm install` deps (Playwright Chromium + sherpa-onnx dominate) | ~1.2 GB | ~1.2 GB |
| Electron desktop build + `desktop/node_modules` | — | ~750 MB |
| `Local Agent X.app` in `/Applications` | — | ~250 MB |
| **Total installed footprint** | **~6 GB** | **~4.5 GB** (or ~3.5 GB if Xcode CLT is already present) |

**Free at least 8 GB** before running the installer. npm extraction and Ollama's content-addressed model pull both need transient scratch space well above their final on-disk size.

**The C++ toolchain is required, not optional** on both platforms — it's how native npm modules (`better-sqlite3`, `sherpa-onnx`, `sqlite-vec`, `@napi-rs/canvas`) compile from source when a prebuilt binary doesn't match your exact Node ABI. The installer bootstraps it for you: on Windows it pulls Visual Studio Build Tools via winget; on macOS, if `xcode-select -p` returns nothing it triggers `xcode-select --install` (a system dialog appears) and exits — you click **Install**, accept the license, then re-run the installer. Bundling the toolchain up-front avoids a half-finished install when a single dep fails to compile.

## Install

Clone or download the repository first, then run the installer for your OS from inside the repo directory:

| OS | How to run |
|---|---|
| macOS | Double-click `install.command` in Finder (or run `./install.sh` from Terminal) |
| Windows | Double-click `install.bat` (or run `.\install.ps1` in PowerShell) |
| Linux | `./install.sh` from a terminal |

> **First-time macOS users:** if you downloaded the repo as a ZIP, the first double-click may be blocked with "cannot be opened because it is from an unidentified developer." Right-click `install.command` → **Open** → **Open** to clear it; subsequent runs go through normally. (`.sh` files are not double-clickable on Mac — they open in a text editor instead of running. The `.command` extension is the macOS convention that tells Finder "run this in Terminal." You do not need Xcode.)

Each script is a thin wrapper that bootstraps Node + Ollama (if missing) and then runs the shared core at [scripts/install-common.mjs](scripts/install-common.mjs); `install.command` itself just hands off to `install.sh` so there's one source of truth.

**What you end up with on macOS:** a real `Local Agent X.app` in `/Applications`, Spotlight- and Launchpad-launchable. Clicking the red X **hides** the window — the server stays alive in the **menu bar** (top-right, next to the clock) so scheduled missions and background jobs keep running. To actually stop the server, use the menu-bar icon's **Quit** item. Headless mode (`npm run dev`) still works for development and is what install.command uses to seed `dist/` for the packaged app. Set `SAX_SKIP_APP=1` to skip the .app build during install if you only want the headless server.

**First-time install on macOS is slow (~3–5 min, ~500 MB)** because it builds the Electron bundle and produces the .app. Subsequent runs are fast (electron-builder caches its downloads).

## Quick start

1. Run `install.command` (double-click in Finder) — wait for "Install complete."
2. Open **Launchpad**, click **Local Agent X**. (First launch only: right-click → **Open** → **Open** to clear macOS Gatekeeper, since the build isn't code-signed.)
3. Sign in a provider. Open **Settings → Model Provider**:
   - **Anthropic** — paste a `claude setup-token` from the Claude CLI (the Anthropic auth on Max plans routes through the CLI subprocess; see [AGENTS.md](AGENTS.md)).
   - **OpenAI / Codex / Cerebras / Ollama** — paste an API key or point at a local endpoint.
4. Talk to the agent. The chat box is the main entry point; voice and scheduled missions live under their own panels on the sidebar.

Embedding defaults are seeded into `~/.lax/settings.json` on first install (Ollama + `mxbai-embed-large`). Provider and chat model are not pre-seeded — you pick them on first run via Settings → Model Provider. Edit `~/.lax/settings.json` directly to change defaults, or change them from the UI.

## Dev commands

| Script | Use |
|---|---|
| `npm run dev` | Run the server in dev mode (tsx, no build step). |
| `npm run dev:watch` | Same, with auto-restart on `src/` changes. |
| `npm run dev:supervised` | Run under the supervisor (auto-restart on crash). |
| `npm run build` | Build to `dist/` for production. |
| `npm start` | Run the built artifact. |
| `npm test` | Run the in-repo test suite. |
| `npm run test:unit` | Run the vitest unit suite. |
| `npm run test:fixtures` | Run prompt-fixture replay tests. |
| `npx tsc --noEmit` | Typecheck without emitting. |

There is no separate lint step.

## Architecture overview

Three lanes for change: **runtime state** flips through HTTP endpoints (settings, provider, theme — never edit files for live state), **self-modification** goes into the agent-editable `config/` directory which hot-reloads, and **external sites** flow through the `browser` tool rather than raw fetch. Every tool call runs through `tool-executor.ts` and the in-process Ari Kernel security layer; new tools need an explicit allow rule in the per-tool policy table (`src/tool-policy/tool-policies.data.ts`). The architectural rules are non-negotiable and live in [AGENTS.md](AGENTS.md) — read that before touching the codebase.

## Status

Active development.

Security contact: see [SECURITY.md](SECURITY.md).

## License

Local Agent X is **source-available** under the Apache License 2.0 with the
[Commons Clause](https://commonsclause.com/) condition. See [LICENSE](LICENSE).

In plain terms:

- **Free, forever, for anyone** — use it, modify it, self-host it, read all the
  source. Companies may run it internally for their own operations at no cost.
- **You may not sell it.** No paid product, no commercial hosted/SaaS offering,
  and no charging others for it or for support/hosting whose value comes from
  the software.
- There is no change date — these terms do not convert to a more permissive
  license over time.

Licensor: Peter Manrique. This summary is for convenience only; the [LICENSE](LICENSE)
file is the binding text.
