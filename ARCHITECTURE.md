# Architecture — where the code lives

A navigation map for reading this codebase, aimed at someone evaluating the
agent's architecture (not installing it). It answers "which file owns X?" for
the major subsystems. The repo has ~65 directories under `src/`, several of
which are **superseded duplicates** that still compile — this map names the
canonical owner and flags the misleading siblings so you don't trace into dead
code.

Companion docs: [AGENTS.md](AGENTS.md) (the invariants/rules), and the deeper
design notes in [docs/](docs/) (`canonical-agent-design.md`, `ari-kernel.md`,
`canonical-loop-prd.md`).

Paths below were verified against the tree (import counts + the live boot path),
not inferred from names.

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
| **Agent / turn loop** | `src/canonical-loop/` | Entry `index.ts`; driver `turn-loop.ts`; chat runner `chat-runner.ts`; durable event store `store.ts`. 19 importers — this is *the* loop. |
| **Provider adapters + routing** | `src/providers/registry.ts`, `src/providers/provider-ids.ts` | Per-turn transport adapters: `src/canonical-loop/adapters/`. Credential resolution: `src/auth/resolve.ts`. Per-provider history prep: `src/agent-request/prepare-request.ts`. |
| **Tool defs + registry + dispatch** | `src/tool-execution/` (entry `execute-tool.ts`) | Registry build: `src/tools/registry-build.ts`; tool impls under `src/tools/`. Public import path `src/tool-executor.ts` is a **re-export shim** of `tool-execution/`. |
| **Tool governance / policy** | `src/tool-policy/tool-policies.data.ts` + `evaluator.ts` | Default-deny; one row per tool. |
| **Security kernel (ARI)** | `src/ari-kernel/` (TS gateway) over `packages/arikernel/*` | The kernel is **TypeScript** (`@arikernel/core`, `policy-engine`, `taint-tracker`, `audit-log`, `tool-executors`, `runtime`), vendored as workspace packages — not a native binary. |
| **Sandbox / isolation** | `src/sandbox/` (`index.ts`, `server-confine.ts`) | Threat classification: `src/threat/`. OS sandbox modes: seatbelt / bwrap / docker. |
| **Memory** | `src/memory/` | `index-core.ts` = `MemoryIndex` (chunking, embeddings, hybrid FTS+vector search); `manager.ts` = `MemoryManager` (curation/extraction/recall). Embedding backends: `src/embedding-providers/`. |
| **Async work / delegation** | `src/ops/` | The op model (`op-store.ts`, `types.ts`) — lanes, context packs, durable `operations.json`. Highest cross-reference count in the repo. |
| **Multi-agent spawn + isolation** | `src/agency/` | `handler.ts` (spawn/route), `worktree.ts` (git-worktree isolation for sub-agents and self-edits). Orchestration middleware: `src/orchestrator/registry.ts`. |
| **Session / context state** | `src/session/` (`router.ts`), `src/context/` (`index.ts`) | Run/template/project/issue persistence: `src/agent-store/`. |
| **Chat streaming transport** | `src/chat-ws/` (`index.ts`, `message-router.ts`) | WebSocket `/ws/chat`. |
| **Voice** | `src/voice/`, `src/bridge-voice/` | Node side is a forwarder; the heavy STT/TTS runs in Python sidecars under `python/`. |
| **Self-edit + platform updates** | `src/self-edit/`, `src/self-edit-sandbox.ts`, `src/self-edit-sandbox-gates.ts` | Both self-edits and platform updates validate in an isolated worktree (deps → build → bind → smoke gates) before landing. Update entry: `src/update-pipeline.ts`. Crash-revert: `src/self-edit-rollback.ts`. |
| **Cross-machine sync** | `src/sync/` (`index.ts`) | `AgentSync` mirrors memory/sessions/config to a private git repo. |
| **Scheduled missions / cron** | `src/cron/` (`cron-service.ts`) | |
| **Desktop app (Electron)** | `desktop/src/` | `main.ts` (Electron main) spawns the Node server (`server-process.ts`) and runs a pre-boot reconcile/build (`reconcile.ts`); window/IPC in `window.ts`, `ipc.ts`. |

## Looks canonical, isn't — ignore these

Superseded code that still exists. Tracing into these will mislead an evaluation.

| Path | Status | Read instead |
|---|---|---|
| `src/routing/` | **Dead** (0 importers) | `src/canonical-loop/` adapter routing |
| `src/conversation/` | **Dead** (0 importers) | `src/session/`, `src/context/` |
| `src/agent-loop-detectors/` | **Dead** (0 importers) | — |
| `src/benchmark-suite/` | **Dead** (0 importers) | `docs/benchmarks/`, `bench/` |
| `src/agent-loop/` | **Superseded** — only `inject-queue.ts` is live (consumed by canonical-loop) | `src/canonical-loop/` |
| `src/context-manager/` | **Deprecated** (2 importers) | `src/context/` |
| `src/tool-executor.ts` | **Shim** (re-export) | `src/tool-execution/` |
| `src/anthropic-client/` | Parse utilities only | provider adapters in `src/canonical-loop/adapters/` |
| `src/codex-client/` | Thin wrapper (1 importer) | `src/providers/` |

## One-line architecture

A single local HTTP server (`127.0.0.1`) runs a durable, lane-based **op model**
(`src/ops/`) on top of a provider-agnostic **turn loop** (`src/canonical-loop/`);
every tool call is gated by an in-process **security kernel** (`src/ari-kernel/`
+ `packages/arikernel/`) against a single **default-deny policy table**
(`src/tool-policy/tool-policies.data.ts`); state (memory, sessions, sync) is
local-first, and the agent can rewrite its own source through a sandbox-gated
**self-edit** pipeline.
