# Architecture — where the code lives

A navigation map for reading this codebase, aimed at someone evaluating the
agent's architecture (not installing it). It answers "which file owns X?" for
the major subsystems, and flags the superseded directories so you don't trace
into dead code.

The raw structural facts — every `src/` directory with its **live importer
count**, size tier, god-file flags, and which dirs have **no live importer** —
are generated into [docs/codebase-map.md](docs/codebase-map.md) by
[`scripts/gen-codebase-map.mjs`](scripts/gen-codebase-map.mjs), and `npm run
build` fails if that file goes stale. This doc owns the *meaning*; the generated
map owns the *counts*. **When a number here disagrees with the map, the map
wins** — it resolves **dynamic `import()`**, which a plain `grep "from"` misses
(that gap is exactly why several live dirs were mislabeled "dead" below before).

Companion docs: [AGENTS.md](AGENTS.md) (the invariants/rules),
[docs/ari-kernel.md](docs/ari-kernel.md) (current security-kernel behavior),
[docs/provider-auth.md](docs/provider-auth.md) (credential storage), and
[docs/mcp-consuming-servers.md](docs/mcp-consuming-servers.md) (MCP trust and
execution), and
[docs/release-qualification.md](docs/release-qualification.md) (release gates,
benchmark evidence, and report interpretation). `docs/history/canonical-agent-design.md`
and `docs/history/canonical-loop-prd.md` are
historical design/ship records; their headers point back to current owners.

Paths below were verified against the tree (the generated map's importer counts
+ the live boot path), not inferred from names.

## Read these first (in order)

1. **`src/index.ts`** — process entry: logger, crash guards, whole-server sandbox confinement re-exec, then the boot sequence.
2. **`src/server/index.ts`** + **`src/server/lifecycle.ts`** — boot-phase orchestration; creates the HTTP server, wires the chat WebSocket, starts the security kernel.
3. **`src/server-context.ts`** — the `ServerContext` handed to route handlers: config, security layer, tool policy, RBAC, session/memory/secrets stores, cron, integrations, the messaging bridges, sync, the app registry and agent stores, plus the chat-WS and broadcast hooks. It is **not** everything: the threat engine, Ari kernel, ops, browser, MCP, approvals and sandbox are module-level singletons reached by import, not through the context.
4. **`src/canonical-loop/index.ts`** → **`src/canonical-loop/turn-loop.ts`** — the agent turn loop: assemble input → call the provider adapter → dispatch tools → persist. This is the core.
5. **`src/tool-policy/tool-policies.<domain>.ts`** (`core`, `network`, `memory`, `orchestration`, `apps`, `globs`) — one entry per tool: allow rule, kernel class, risk tier, rate limit, path args. `tool-policies.data.ts` only merges the six fragments into `TOOL_POLICIES`; `~/.lax/tool-policy.json` user overrides and `packs/` are merged on top at runtime.
6. **`src/ari-kernel/index.ts`** — the in-process security kernel gateway every tool call passes through.

## Subsystem map

| Capability | Canonical code | Notes |
|---|---|---|
| **Server entry + HTTP boot** | `src/index.ts` → `src/server/index.ts`, `src/server/lifecycle.ts` | Services: `src/server/bootstrap-services.ts`. Tools: `src/server/bootstrap-tools.ts`. Loop adapter registration: `src/server/canonical-loop-bootstrap.ts`. A second loopback listener, `src/server/agent-origin.ts`, serves agent-written apps/files from its own origin so they cannot touch the shell's DOM or token. |
| **Agent / turn loop** | `src/canonical-loop/` | Entry `index.ts`; driver `turn-loop.ts`; chat runner `chat-runner.ts`; durable event store `store.ts`. One of the most-imported subsystems (see the map) — this is *the* loop. The module boundary is sealed: outside consumers import `index.ts` or the `public/` sub-barrels, enforced by `interface-seal.test.ts`. `src/agent-loop/` is one live file, `inject-queue.ts` (mid-turn user injections), consumed by the loop, `src/agency/handler.ts` and `src/chat-ws/inject-router.ts`. |
| **Per-turn request pipeline** | `src/agent-request/prepare-request.ts` + `prepare-request/` | The whole per-turn assembly: provider/model resolution, attachments, context build, system prompt, tool selection, learned-protocol suggestion. Per-provider history cleanup (tool-result tag stripping, orphan repair) is `src/providers/sanitize.ts`. |
| **Provider adapters + routing** | `src/providers/registry.ts`, `src/providers/provider-ids.ts` | Loop-side transports: `src/canonical-loop/adapters/`. Wire-level adapters: `src/providers/adapters/` (`openai-http`, `ollama-native`, `codex-cli`) over the `src/providers/adapter/base-adapter.ts` contract. Credential resolution: `src/auth/resolve.ts`. |
| **Local model runtimes** | `src/local-runtimes/` (`index.ts`) | Discovery and probing of Ollama / LM Studio / LAN endpoints, endpoint admission, model profiles, context sizing, GPU memory, and the local-model certification runner. |
| **Short LLM side-calls** | `src/llm-dispatch.ts` + `src/llm-dispatch/` | One-shot completions for memory extraction, planning and classifiers; `hosted.ts` is the Anthropic/OpenAI/xAI/Codex leg (dynamic-imports `src/anthropic-client/`), `ollama.ts` the local leg. `src/classifiers/` are the regex-first, LLM-second yes/no classifiers (`classify-with-llm.ts`) that run on the provider's background model. |
| **Anthropic transport** | `src/anthropic-client/` | API streaming (`stream-api.ts`) and warm-pool CLI streaming (`stream-cli.ts`, `warm-pool/`); imported statically by many modules and dynamically by `src/canonical-loop/adapters/anthropic-transport.ts`. |
| **Tool defs + registry + dispatch** | `src/tool-execution/` (entry `execute-tool.ts`) | Registry build: `src/tools/registry-build.ts`; tool impls under `src/tools/`. Category kill-switches (`enableComputerControl`, screen capture, …) are the table in `src/tool-execution/kill-switch-gates.ts`, applied by `pre-dispatch.ts`. |
| **Tool governance / policy** | `src/tool-policy/tool-policies.<domain>.ts` + `evaluator.ts` | Default-deny; one row per tool (or glob family) across six domain fragments. `evaluator.ts` runs the rule packs in priority order: default-policy, security-layer, threat-engine, spend-cap, egress-refutation. |
| **Tool approvals** | `src/tool-execution/require-approval.ts`, `src/approval-manager.ts`, `src/approval-decision.ts` | Live tool-call gate for risky actions. `approval-manager.ts` emits the `approval_requested` event (a durable copy lands in the op store via `src/canonical-loop/control-api-approvals.ts`); the UI handles it in `public/js/chat-stream-reducer.js` and draws the card in `public/js/chat-render-approvals.js`. Separate from retired issue-level approval fields. |
| **Autonomy profiles** | `src/autonomy/` (`profiles.ts`, `risk.ts`) | The Safe / Normal / Developer / Power / Autonomous tables mapping tool risk → allow / allow-with-rollback / ask / deny; `rollback.ts` is the safety net behind allow-with-rollback. |
| **Retry / resilience policy** | `src/auto-retry.ts`, `src/resilience-policy.ts` | Retries only recognized transient categories and only replay-safe tool effects: read-only, idempotent mutation, or keyed mutation with an operation key. Missing effect metadata and non-idempotent mutations are not auto-retried. |
| **Loop guards** | `src/agent-guards/` (`index.ts`) | Provider-independent loop detection, dead-end and livelock shapes, claim grounding, build-command and verify gates, used by the canonical-loop middlewares. |
| **Security kernel (ARI)** | `src/ari-kernel/` (TS gateway) over `packages/arikernel/*` | The kernel is **TypeScript** (`@arikernel/core`, `policy-engine`, `taint-tracker`, `audit-log`, `tool-executors`, `runtime`), vendored as workspace packages — not a native binary. |
| **Security policy layer** | `src/security/layer/` + `src/security/secrets/` | `layer/` = SecurityLayer policy core (file access, shell policy, network policy); `secrets/` = secret/credential detection. Each has an `index.ts` barrel; the root `src/security/index.ts` is a compat façade re-exporting both. |
| **Workspace identity** | `src/workspace/` (`paths.ts`, `lifecycle.ts`) | Canonical real-path resolution (junction/symlink-aware) and the per-session work-root registry every file gate consults; `lifecycle.ts` owns where the workspace physically lives (OneDrive remap, relocation); `workspace-location.ts` says why a folder may not serve as one. |
| **Sandbox / isolation** | `src/sandbox/` (`index.ts`, `server-confine.ts`) | Selected default is `guarded` (`src/config-schema.ts`); macOS/Linux use a credential-denying kernel cage with network retained. On Windows the cage is a dedicated sandbox user fenced by the Windows firewall (WFP) through the `packages/srt-win` helper — `win-cage.ts`, `win-cage-grants.ts`, `win-cage-install.ts` — proven by a connect probe before first use. Unsupported hosts visibly fall back to unconfined `host`; unattended shell paths require acknowledgement. `docker` is an opt-in per-command container on `--network none` or an approved internal bridge (`docker-shell.ts`, `docker-execution-runtime.ts`); `seatbelt` / `bwrap` are selected only through `LAX_SANDBOX` or the config `sandboxMode`. |
| **Shell egress proxy** | `src/net/` | `egress-proxy-core.ts` is the loopback HTTP/CONNECT proxy that applies the egress policy; `shell-egress-proxy.ts` + `shell-egress-bridge.ts` bind it for the caged shell. Tool-side egress still goes through `http_request` / `web_fetch`. |
| **Browser backends + secret guards** | `src/browser/instance.ts`, `src/browser/route-resolve.ts`, `src/browser/in-app-backend.ts`, `src/browser/runtime.ts`, `src/browser/secret-ops.ts` | `browserMode` defaults to `in-app`: an embedded WebContentsView the user can watch and co-drive (`desktop/src/browser-views.ts`), one per (session, profile) on a hardened partition. `resolveBrowserRoute()` in `route-resolve.ts` (re-exported by `instance.ts`) is the one fallback matrix — a non-`in-app` mode, `LAX_BROWSER_HEADLESS=1`, or an absent desktop bridge routes to the external-Chrome CDP `BrowserManager` instead, and says which and why. `isolated` / `continuity` / `advanced-shared` select external Chrome with per-session, persistent, or shared identity. Secret fill/capture run on **both** backends via `SecretBrowserOps` and enforce credential-field selectors, exact origin binding, and first-use approval/pre-blessing. Every mode uses an agent-owned profile, never the user's own browser profile. |
| **Android device control** | `src/android/` (`index.ts`) | The mobile-testing counterpart to the browser: SDK location/install, adb device I/O, emulator lifecycle, frame stream. |
| **Provider authentication** | `src/auth/`, `docs/provider-auth.md` | LAX-owned credentials are path-bound encrypted `lax-auth-v2` envelopes. External CLI stores keep their native formats; the default Codex bridge creates a temporary plaintext mirror only when needed and removes it after the subprocess. |
| **MCP client trust** | `src/mcp-client/`, `docs/mcp-consuming-servers.md` | Config defaults to `sandboxed`; unsupported confinement blocks. Trusted host execution requires exact local approval or a valid manifest from a configured signed publisher, with integrity pinning retained as fallback defense. |
| **Plugins (third-party tools)** | `src/plugin-system/` | Plugin manifests, publisher trust and integrity checks, secret requirements, and `tool-surface.ts`, which registers a plugin's tools into the live registry. |
| **Integrations (external services)** | `src/integrations/` (`registry.ts`, `builtins/`) | Declarations of GitHub, Google, Slack, Notion, … endpoints with their credential requirements and egress checks; the single-entry install path the agent acts on. |
| **App platform** | `src/app-runtime/` (`index.ts`) | Agent-built interactive apps: registry, per-app permissions, state and event stores, validation, rate limits. `audit-signing.ts` + `src/threat/audit-trail.ts` use keyed HMAC chains backed by a sealed persistent seed; the prior entry's signature is hashed into `prevHash`, and legacy unkeyed verification cannot reopen after the HMAC era is established. |
| **App Map (self-manifest)** | `src/manifest-generator/` | Scans pages, tabs, routes, settings and tools into `config/app-manifest.json` at startup and on source change, so the agent knows what already exists. |
| **Exfil / threat engine** | `src/threat/` (`threat-engine.ts`) | Data-flow exfil blocking (sensitive read → outbound send) lives in `tool-chain.ts`; `scoring.ts` is a per-session risk score that restricts only on hard evidence (a secret actually in an outbound payload, a canary tripped) — timing-based read-then-send correlation was dropped. Trust ledger, canaries, hash-chained audit trail. Classifications feed the policy gate. |
| **Data lineage / taint tracking** | `src/data-lineage/` (`index.ts`) | Session-scoped taint registry complementing the threat engine's regex checks: data read from a sensitive source (`paths.ts`) is fingerprinted (`fingerprint.ts`) and tainted (`taint.ts`); if that data later reaches an egress channel it is blocked by CALL SEQUENCE even after transforms (base64/chunk/`bash`), because the LLM can't "un-see" a sensitive source it already ingested. |
| **Memory** | `src/memory/` | `index-core.ts` = `MemoryIndex` (chunking, embeddings, hybrid FTS+vector search); `manager.ts` = `MemoryManager` (curation/extraction/recall); `session-store.ts` = `SessionStore` (one `~/.lax/sessions/<id>.jsonl` per chat session). Stored locally by default, but Agent Sync can copy memory Markdown and `memory.db` into its configured private Git remote. Embedding backends: `src/embedding-providers/`. |
| **Persona / cognition** | `src/cognition/` | The persona constellation (emotional memory, narrative memory, correction learning, anticipatory care, cross-session learning, …), consolidated from ~18 root modules. Distinct from `src/memory/cognitive/`. Shared JSON persistence helper: `src/util/json-store.ts`. The dispatcher over these is `MemoryOrchestrator` (`src/orchestrator/orchestrator.ts`), driven by the one cognitive-signal table in `src/orchestrator/registry.ts`. |
| **Protocols / skills** | `src/protocols/` (`index.ts`, `loader.ts`) | Bundled `SKILL.md` protocols (`bundled/`), typed packs (`packs/`), per-user preferences, search, evaluation and the `protocol` tool. The `learned-*.ts` files are the learned tier below. |
| **Self-learning protocols** | `src/cognition/cross-session-learning/` + `src/protocols/learned-*.ts`, `docs/learned-protocols.md` | Mines proven workflows into versioned, outcome-scored learned `SKILL.md` protocols. Seams: evidence at `src/canonical-loop/turn-loop/record-outcome.ts`, reconcile driver at `src/orchestrator/signals-meta.ts` (every fifth message), capability-envelope gate at `src/tool-execution/learned-protocol-envelope.ts`, surfacing at `src/agent-request/prepare-request/build-context.ts`, HTTP at `src/routes/memory-learning.ts`. `learningMode` (`assisted` default / `autonomous`) is a protected setting; a learned protocol only *restricts* capability, never expands it. |
| **Async work / delegation** | `src/ops/` | The op model (`op-store.ts`, `types.ts`) — lanes, context packs, one durable `operation.json` per op under `~/.lax/operations/<id>/`. Among the most cross-referenced subsystems in the repo. |
| **Multi-agent spawn + isolation** | `src/agency/`, `src/agents/` | `agency/handler.ts` (spawn/route), `agency/worktree.ts` (a barrel over `worktree-lifecycle.ts` / `worktree-state.ts` / `worktree-recovery.ts` — git-worktree isolation for sub-agents and self-edits). `agents/` is the spawned-agent side: `briefing.ts` builds the context a history-less agent starts with, `invoke.ts` + `runtime.ts` run it on the canonical loop, `watchdog.ts` and `result-guard.ts` police it. |
| **Autopilot + app-build** | `src/autopilot/`, `src/auto-build/` | `autopilot/start.ts`: developer-mode-only autonomous rounds in a named worktree under a per-repo lock. `auto-build/`: the `/app-build` workflow — `app-build-tool.ts` (plan), `tool.ts` + `loop/` (run the plan to completion), conflict graph, scenario scorer. |
| **Session / context state** | `src/session/`, `src/context/` (`system-prompt-builder.ts`) | `session/router.ts` links one user's identity across Telegram / WhatsApp / web / CLI (`~/.lax/identity-links.json`); chat persistence is `SessionStore` in `src/memory/`. `src/context/` builds the prompt *input*; token-budget auto-compaction is the separate `src/context-manager/` (single budget/compaction policy table: `compaction-policy.ts`), driven by the loop's `turn-loop/compact-history.ts`. Run/template/project/issue persistence: `src/agent-store/`. |
| **Chat streaming transport** | `src/chat-ws/` (`index.ts`, `message-router.ts`) | WebSocket `/ws/chat`. |
| **Messaging bridges** | `src/telegram-bridge/`, `src/whatsapp-bridge/` | Telegram: long-polled Bot API, no webhook. WhatsApp: Baileys (WA Web), QR pairing. Both feed the canonical loop; bridge-side voice notes go through `src/bridge-voice/`. |
| **Lifecycle hooks** | `src/hooks/` (`hook-engine.ts`) | `~/.lax/hooks.json` command/HTTP hooks on tool and session events; scrubbed env, localhost-only HTTP. |
| **Connectors (external APIs)** | `src/routes/connector-proxy.ts`, `src/routes/connector-signing.ts` | User-data manifests in `<lax data dir>/connectors/<name>.json` surface as `/api/connectors/<name>/...` (incl. HMAC `signed` auth) without core changes; sandboxed apps reach them through an app-scoped capability (`src/server/app-connector-auth.ts`). Setup tool: `src/tools/connector-tools.ts`. |
| **Computer control (mouse/kbd)** | `src/computer-control.ts`, `src/tools/input-tools.ts` (the `computer` tool) | nut.js driver in `src/tools/input-driver.ts`; off by default (`enableComputerControl`), gated by `src/tool-execution/kill-switch-gates.ts` from `pre-dispatch.ts`, typed text classed as egress. |
| **Remote screen + control** | `src/screen-stream/` (`index.ts`, `peer.ts`) | WebRTC desktop stream to a paired mobile device — ffmpeg `gdigrab` capture, Windows-only today (`ffmpeg-capture.ts`) — with remote input back (`screen-input.ts`); signaling state machine in `signaling-machine.ts`; the encoder's bitrate steps with the phone's receiver reports (`bitrate-ladder.ts`, `stream-quality.ts`). The phone reaches it over `src/broker-transport/` (`broker-screen-dialer.ts`). |
| **Phone transport (broker)** | `src/broker-transport/` | The only phone↔desktop transport: the broker rendezvous (`broker-dialer.ts`) carries screen, voice and chat (`chat-bridge.ts`, `http-tunnel-bridge.ts`) over WebRTC signals; `config.ts` resolves dial parameters. Every message the phone and desktop exchange is defined once in agentxos and vendored into `vendor/` (copied by `scripts/check-vendor-sync.mjs --sync`, checked by `npm run build`; see `vendor/README.md`). |
| **Voice** | `src/voice/`, `src/server/voice-ws.ts` | The pipeline is in Node: sherpa-onnx streaming STT (`stt-stream.ts`) and Silero VAD (`vad-stream.ts`), per-utterance Whisper correction (`whisper-stream.ts`), Opus codec + werift WebRTC peer (`opus-codec.ts`, `voice-peer.ts`), session driver `voice-session/`, cloud STT providers (`stt-providers/`), and local TTS (`tts-local.ts`: Piper direct, Kokoro via a one-shot Python call, Windows SAPI floor). `/ws/voice` is wired in `src/server/voice-ws.ts`. `python/` hosts only the voice-clone engines (`chatterbox/`, `voxcpm/`) and the "Lite" Kokoro+Whisper sidecar (`python/voice/`), probed from `tts-sidecars.ts`. |
| **Self-edit + platform updates** | `src/self-edit/` (`sandbox.ts`, `sandbox-gates.ts`) | Both self-edits and platform updates validate in an isolated worktree (deps → build → bind → smoke gates) before landing. Update entry: `src/update-pipeline.ts`. Crash-revert: `src/self-edit/rollback.ts`. |
| **Release qualification** | `scripts/release-gate.mjs`, `scripts/release-gates.mjs`, `scripts/local-qualification/` | One source/tooling-bound gate runs the ordered release checks and emits machine-readable evidence. Versioned installer, local-model, plugin, and channel packs are defined by `scripts/local-qualification/benchmark-packs.mjs`; the three versioned publisher workflows (`.github/workflows/release.yml`, `installer-release.yml`, `build-voice-artifacts.yml`) depend on the gate before packaging or upload. |
| **Cross-machine sync** | `src/sync/` (`index.ts`) | `AgentSync` mirrors configured memory, sessions, sanitized config/UI state, and workspace data to a user-configured Git remote. The product expects a private repository but does not enforce repository visibility. |
| **Scheduled missions / cron** | `src/cron/` (`cron-service.ts`) | |
| **Desktop app (Electron)** | `desktop/src/` | `main.ts` (Electron main) spawns the Node server (`server-process.ts`) and runs a pre-boot reconcile/build (`reconcile.ts`); window/IPC in `window.ts`, `ipc.ts`. |

## Looks canonical, isn't — ignore these

The authoritative **"no live importer"** set is computed in
[docs/codebase-map.md](docs/codebase-map.md) (currently empty — every `src/`
directory has a live importer). The rows below are the curated cases a raw
count can't explain: a dir that *looks* like a canonical owner but isn't.

| Path | Status | Read instead / note |
|---|---|---|
| `src/orchestrator/registry.ts` | Not multi-agent orchestration | The cognitive-signal table behind `MemoryOrchestrator` (persona/memory modules). Agent spawning is `src/agency/`; op scheduling is `src/canonical-loop/`. |
| `src/security/index.ts` | Compat façade | Re-exports `src/security/layer/` and `src/security/secrets/`; read those. |

### Live, but reached only by dynamic `import()`

A `grep "from"` shows zero importers for these, and an earlier version of this
doc wrongly called them "dead." They are wired in and running:

| Path | What it actually is |
|---|---|
| `src/routing/` | The "run this message inline vs. delegate to a worker" decision — dynamically imported by `src/routes/chat/run-chat-turn/*` and `src/routes/chat/auto-delegate-routes.ts`. |
| `src/conversation/` | The chat-export → memory **ingest** pipeline (`ingest.ts`) — dynamically imported by `src/routes/memory.ts` and `src/memory/tools/ingest.ts`. |

`src/context-manager/` and `src/anthropic-client/` were once listed here too;
both have many static importers and sit in the subsystem map above.

## One-line architecture

A local HTTP server on `127.0.0.1` (plus an agent-origin sibling listener for
agent-written pages) runs a durable, lane-based **op model** (`src/ops/`) on
top of a provider-agnostic **turn loop** (`src/canonical-loop/`); every tool
call is gated by an in-process **security kernel** (`src/ari-kernel/` +
`packages/arikernel/`) against a single **default-deny policy table**
(`src/tool-policy/tool-policies.<domain>.ts`, merged by `tool-policies.data.ts`);
state (memory, sessions, sync) is local-first, and the agent can rewrite its
own source through a sandbox-gated **self-edit** pipeline.
