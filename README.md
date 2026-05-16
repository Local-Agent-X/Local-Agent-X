# Local Agent X

A self-hosted personal agent platform. Runs entirely on your machine — your files, your keys, your conversations. Speaks multiple LLM providers (Anthropic, OpenAI, Cerebras, Ollama, Codex CLI), so you're not locked into one vendor's pricing or availability.

Beyond chat, it ships voice (push-to-talk and full-duplex), scheduled missions on cron, a tool-executor with a default-deny policy, and a workspace where the agent builds and serves its own small apps. The runtime UI is a single HTTP server you open in any browser. Self-modification routes through a `config/` directory that hot-reloads; deeper changes go through a `self_edit` tool wired into the runtime.

It's research-grade software, not a polished product. Active development — see [Status](#status) for the current refactor.

## Prerequisites

- **Node.js 22+** (the install scripts will fetch this if missing).
- **Ollama** for local embeddings (the install scripts will fetch this; the `mxbai-embed-large` model is pulled automatically, ~670MB one-time).
- **OS support**: Windows 10/11, macOS (Apple Silicon or Intel), Debian/Ubuntu Linux.
- **Disk**: ~3GB for Node modules + Playwright Chromium + the embedding model.

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

Defaults are seeded into `~/.sax/settings.json` on first install (Anthropic + Sonnet 4.6, Ollama embeddings). Edit that file directly to change defaults, or change them from the UI.

## Dev commands

| Script | Use |
|---|---|
| `npm run dev` | Run the server in dev mode (tsx, no build step). |
| `npm run dev:watch` | Same, with auto-restart on `src/` changes. |
| `npm run dev:supervised` | Run under the supervisor (auto-restart on crash). |
| `npm run build` | Build to `dist/` for production. |
| `npm start` | Run the built artifact. |
| `npm test` | Run the in-repo test suite. |
| `npm run test:fixtures` | Run prompt-fixture replay tests. |
| `npx tsc --noEmit` | Typecheck without emitting. |

There is no separate lint step.

## Architecture overview

Three lanes for change: **runtime state** flips through HTTP endpoints (settings, provider, theme — never edit files for live state), **self-modification** goes into the agent-editable `config/` directory which hot-reloads, and **external sites** flow through the `browser` tool rather than raw fetch. Every tool call runs through `tool-executor.ts` and the in-process Ari Kernel security layer; new tools need an explicit allow rule in `tool-policy.ts`. The architectural rules are non-negotiable and live in [AGENTS.md](AGENTS.md) — read that before touching the codebase.

The canonical-loop refactor that landed in May 2026 (one agent loop, one tool resolver, one adapter registry path) is archived at [docs/audits/2026-05-canonical-refactor/INDEX.md](docs/audits/2026-05-canonical-refactor/INDEX.md).

## Status

Active development. The current convergence pass is the DRY repair effort:

- [AUDIT-STATE.md](AUDIT-STATE.md) — status summary, points at the completed canonical-loop audit and the active DRY work.
- [DRY-AUDIT.md](DRY-AUDIT.md) — duplicated-knowledge findings (F1–F15).
- [DRY-REPAIR-PLAN.md](DRY-REPAIR-PLAN.md) — phased plan closing those findings.

Security contact: see [SECURITY.md](SECURITY.md).
