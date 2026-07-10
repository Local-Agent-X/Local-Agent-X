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
execution). `canonical-agent-design.md` and `canonical-loop-prd.md` are
historical design/ship records; their headers point back to current owners.

Paths below were verified against the tree (the generated map's importer counts
+ the live boot path), not inferred from names.

## Read these first (in order)

1. **`src/index.ts`** — process entry: logger, crash guards, Chromium/sandbox flags, then the boot sequence.
2. **`src/server/index.ts`** + **`src/server/lifecycle.ts`** — boot-phase orchestration; creates the HTTP server, wires the chat WebSocket, starts the security kernel.
3. **`src/server-context.ts`** — the `ServerContext` dependency surface: every major subsystem handed to the request handlers. The cleanest single view of "what's wired to what."
4. **`src/canonical-loop/index.ts`** → **`src/canonical-loop/turn-loop.ts`** — the agent turn loop: assemble input → call the provider adapter → dispatch tools → persist. This is the core.
5. **`src/tool-policy/tool-policies.data.ts`** — the single table of every tool's allow rule, kernel class, risk tier, and rate limit. The whole tool-governance model in one file.
6. **`src/ari-kernel/index.ts`** — the in-process security kernel gateway every tool call passes through.

## Subsystem map

| Capability | Canonical code | Notes |
|---|---|---|
| **Server entry + HTTP boot** | `src/index.ts` → `src/server/index.ts`, `src/server/lifecycle.ts` | Services: `src/server/bootstrap-services.ts`. Tools: `src/server/bootstrap-tools.ts`. Loop adapter registration: `src/server/canonical-loop-bootstrap.ts`. |
| **Agent / turn loop** | `src/canonical-loop/` | Entry `index.ts`; driver `turn-loop.ts`; chat runner `chat-runner.ts`; durable event store `store.ts`. One of the most-imported subsystems (see the map) — this is *the* loop. |
| **Provider adapters + routing** | `src/providers/registry.ts`, `src/providers/provider-ids.ts` | Per-turn transport adapters: `src/canonical-loop/adapters/`. Credential resolution: `src/auth/resolve.ts`. Per-provider history prep: `src/agent-request/prepare-request.ts`. |
| **Tool defs + registry + dispatch** | `src/tool-execution/` (entry `execute-tool.ts`) | Registry build: `src/tools/registry-build.ts`; tool impls under `src/tools/`. Public import path `src/tool-executor.ts` is a **re-export shim** of `tool-execution/`. |
| **Tool governance / policy** | `src/tool-policy/tool-policies.data.ts` + `evaluator.ts` | Default-deny; one row per tool. |
| **Tool approvals** | `src/tool-execution/require-approval.ts`, `src/approval-manager.ts`, `src/approval-decision.ts` | Live tool-call gate for risky actions; emits `approval_requested` and is rendered by `public/js/chat-stream-store.js`. This is separate from retired issue-level approval fields. |
| **Retry / resilience policy** | `src/auto-retry.ts`, `src/resilience-policy.ts` | Retries only recognized transient categories and only replay-safe tool effects: read-only, idempotent mutation, or keyed mutation with an operation key. Missing effect metadata and non-idempotent mutations are not auto-retried. |
| **Security kernel (ARI)** | `src/ari-kernel/` (TS gateway) over `packages/arikernel/*` | The kernel is **TypeScript** (`@arikernel/core`, `policy-engine`, `taint-tracker`, `audit-log`, `tool-executors`, `runtime`), vendored as workspace packages — not a native binary. |
| **Sandbox / isolation** | `src/sandbox/` (`index.ts`, `server-confine.ts`) | Selected default is `guarded` (`src/config-schema.ts`); macOS/Linux use a credential-denying kernel cage with network retained. Unsupported hosts visibly fall back to unconfined `host`; unattended shell paths require acknowledgement. Stricter modes: seatbelt / bwrap / docker. |
| **Browser identity + secret guards** | `src/browser/runtime.ts`, `src/browser/instance.ts`, `src/browser/secret-fill.ts` | `browserMode` defaults to per-session `isolated`; `continuity` and live-context `advanced-shared` are explicit choices. Secret fill enforces credential-field selectors, exact origin binding, and first-use approval/pre-blessing. All modes use the agent-owned Chrome profile, never the user's default profile. |
| **Provider authentication** | `src/auth/`, `docs/provider-auth.md` | LAX-owned credentials are path-bound encrypted `lax-auth-v2` envelopes. External CLI stores keep their native formats; the default Codex bridge creates a temporary plaintext mirror only when needed and removes it after the subprocess. |
| **MCP client trust** | `src/mcp-client/`, `docs/mcp-consuming-servers.md` | Config defaults to `sandboxed`; unsupported confinement blocks. Trusted host execution requires exact local approval or a valid manifest from a configured signed publisher, with integrity pinning retained as fallback defense. |
| **Audit signing** | `src/app-runtime/audit-signing.ts`, `src/threat/audit-trail.ts` | Current entries use keyed HMAC chains backed by a sealed persistent seed; the prior entry's signature is hashed into `prevHash`. Legacy unkeyed verification cannot reopen after the HMAC era is established. |
| **Exfil / threat engine** | `src/threat/` (`threat-engine.ts`, `session-threat-manager.ts`) | Per-session temporal threat scoring + data-flow exfil blocks (`scoring.ts`), tool-chain risk (`tool-chain.ts`), trust ledger, canaries, hash-chained audit trail. Classifications feed the policy gate. |
| **Memory** | `src/memory/` | `index-core.ts` = `MemoryIndex` (chunking, embeddings, hybrid FTS+vector search); `manager.ts` = `MemoryManager` (curation/extraction/recall). Stored locally by default, but Agent Sync can copy memory Markdown and `memory.db` into its configured private Git remote. Embedding backends: `src/embedding-providers/`. |
| **Async work / delegation** | `src/ops/` | The op model (`op-store.ts`, `types.ts`) — lanes, context packs, durable `operations.json`. Among the most cross-referenced subsystems in the repo. |
| **Multi-agent spawn + isolation** | `src/agency/` | `handler.ts` (spawn/route), `worktree.ts` (git-worktree isolation for sub-agents and self-edits). Orchestration middleware: `src/orchestrator/registry.ts`. |
| **Session / context state** | `src/session/` (`router.ts`), `src/context/` (`builder.ts`) | Token-budget auto-compaction is a separate live module — `src/context-manager/`, driven by the loop's `turn-loop/compact-history.ts`. Run/template/project/issue persistence: `src/agent-store/`. |
| **Chat streaming transport** | `src/chat-ws/` (`index.ts`, `message-router.ts`) | WebSocket `/ws/chat`. |
| **Connectors (external APIs)** | `src/routes/connector-proxy.ts`, `src/routes/connector-signing.ts` | User-data manifests in `<lax data dir>/connectors/<name>.json` surface as `/api/connectors/<name>/...` (incl. HMAC `signed` auth) without core changes; sandboxed apps reach them through an app-scoped capability (`src/server/app-connector-auth.ts`). Setup tool: `src/tools/connector-tools.ts`. |
| **Computer control (mouse/kbd)** | `src/computer-control.ts`, `src/tools/input-tools.ts` (the `computer` tool) | nut.js driver in `src/tools/input-driver.ts`; off by default (`enableComputerControl`), gated in `src/tools/pre-dispatch.ts`, typed text classed as egress. |
| **Remote screen + control** | `src/screen-stream/` (`index.ts`, `peer.ts`) | WebRTC desktop stream to a paired mobile device (`ffmpeg-capture.ts`) with remote input back (`screen-input.ts`); signaling state machine in `signaling-machine.ts`. |
| **Voice** | `src/voice/`, `src/bridge-voice/` | Node side is a forwarder; the heavy STT/TTS runs in Python sidecars under `python/`. |
| **Self-edit + platform updates** | `src/self-edit/`, `src/self-edit-sandbox.ts`, `src/self-edit-sandbox-gates.ts` | Both self-edits and platform updates validate in an isolated worktree (deps → build → bind → smoke gates) before landing. Update entry: `src/update-pipeline.ts`. Crash-revert: `src/self-edit-rollback.ts`. |
| **Cross-machine sync** | `src/sync/` (`index.ts`) | `AgentSync` mirrors configured memory, sessions, sanitized config/UI state, and workspace data to a user-configured Git remote. The product expects a private repository but does not enforce repository visibility. |
| **Scheduled missions / cron** | `src/cron/` (`cron-service.ts`) | |
| **Desktop app (Electron)** | `desktop/src/` | `main.ts` (Electron main) spawns the Node server (`server-process.ts`) and runs a pre-boot reconcile/build (`reconcile.ts`); window/IPC in `window.ts`, `ipc.ts`. |

## Looks canonical, isn't — ignore these

Superseded code that still exists. Tracing into these will mislead an evaluation.
The authoritative **"no live importer"** set is computed in
[docs/codebase-map.md](docs/codebase-map.md) (currently empty).
The rows below are the curated cases a raw count can't explain — a shim, or a dir
that *looks* like the canonical owner but isn't:

| Path | Status | Read instead / note |
|---|---|---|
| `src/agent-loop/` | **Pruned to one live file** — `inject-queue.ts` (consumed by canonical-loop); the rest is gone | `src/canonical-loop/` |
| `src/tool-executor.ts` | **Shim** (re-export) | `src/tool-execution/` |
| `src/anthropic-client/` | Parse/convert utilities only — **not** the turn transport | provider adapters in `src/canonical-loop/adapters/` |

### Live, but easy to misread as dead

These are reached **only by dynamic `import()`**, so a `grep "from"` shows zero
importers and the earlier version of this doc wrongly called them "dead." They are
wired in and running — do not skip them:

| Path | What it actually is |
|---|---|
| `src/routing/` | The "run this message inline vs. delegate to a worker" decision — imported by `src/routes/chat/`. |
| `src/conversation/` | The chat-export → memory **ingest** pipeline (`ingest.ts`) — imported by the `/api/memory` route + `src/memory/tools/`. |
| `src/agent-loop-detectors/` | **Post-turn validation** (planning-only / single-tool-then-stop detection) — imported by the loop's `post-turn-detector` middleware. |
| `src/context-manager/` | Token-budget tracking + **auto-compaction** — imported by the loop's `turn-loop/compact-history.ts`. Don't confuse with `src/context/` (input builder). |

## One-line architecture

A single local HTTP server (`127.0.0.1`) runs a durable, lane-based **op model**
(`src/ops/`) on top of a provider-agnostic **turn loop** (`src/canonical-loop/`);
every tool call is gated by an in-process **security kernel** (`src/ari-kernel/`
+ `packages/arikernel/`) against a single **default-deny policy table**
(`src/tool-policy/tool-policies.data.ts`); state (memory, sessions, sync) is
local-first, and the agent can rewrite its own source through a sandbox-gated
**self-edit** pipeline.
