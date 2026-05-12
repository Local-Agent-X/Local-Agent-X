# Local Agent X — Codebase Audit

**Scope:** orchestration consolidation, adapter consistency, dead code, single-path architecture.
**Date:** 2026-05-12.
**Mode:** READ-ONLY — no edits, deletions, or "small fixes along the way."
**Coverage:** `src/` (662 TS files) traced; auxiliary trees (`desktop/`, `eval/`, `tests/`, `python/`, `integrations/`) noted only where they're entry points.

> Methodology: four parallel research passes (entry points + orchestration paths; adapter inventory + shared state; duplicate logic + collisions; dead code) plus synthesis. Every finding is anchored with file paths and line numbers so claims can be re-verified independently.

---

## Critical Findings

These are the items you should know before reading the rest. Each is anchored in the detailed sections below; nothing has been touched.

1. **Three live agent-turn loops coexist with non-trivial behavioral drift.** Legacy per-provider loops (`src/providers/run-standard.ts`, `src/providers/run-anthropic.ts`, `src/agent-codex/run-http.ts`), a gated unified middleware loop (`src/agent-loop/run.ts`, env `LAX_UNIFIED_LOOP=1`), and the canonical-loop (`src/canonical-loop/`). Chat traffic uses canonical; everything else (cron, autopilot, sub-agents, workers, voice, delegation handoff) still routes through the legacy loops via `runAgent`. The three loops have different idle/wall-clock timeouts (180s vs 600s), different stop-the-runaway heuristics, and different middleware coverage.

2. **Canonical chat silently no-ops large parts of the legacy safety stack.** Loop-detection, dead-end nudge, post-commit nudge, hallucination check, action-claim check, self-check, mid-turn-evidence-stale, force-tool-use, post-turn-detector, and auto-route-build-app — all exist as middlewares in `src/agent-loop/middlewares/` and inline in the legacy loops, but **none run on the canonical chat path**. This is a behavior gap, not just a code smell.

3. **`routes/chat.ts:287-433` has two writers for `session.messages` in a single turn.** The canonical-loop path appends to `op_messages.jsonl` and re-synthesizes `session.messages` from disk; the legacy-fallback path mutates `session.messages` in place. The snapshot-and-revert hack at `routes/chat.ts:294`/`:425` exists specifically because both writers can run for the same turn if canonical throws mid-execution. Disk and memory can drift.

4. **`_localNoToolModels: Set<string>` is a process-wide mutable Set written by two adapter towers and never reset.** Declared at `src/providers/types.ts:35`. Mutated by `src/providers/adapters/openai-http.ts:54` (legacy + unified loops) and read/mutated indirectly by `src/canonical-loop/adapters/openai-compat.ts:33,110`. A transient "no tools" flap on any local model demotes it permanently for the process lifetime across both loops.

5. **Stacked retry layers with no shared budget and no correlation key.** A single 429 can be retried by `tool-executor` (`withRetry`), inside the stream-error handler in each legacy loop (`forceCompact` + `continue`), then by the inline cascade in `routes/chat.ts:525-580` against a different provider — plus the warm-pool's own subprocess retry. `retry-telemetry.ts:logRetry` is called from every layer with no `correlationId` so the chain is unreconstructable.

6. **Two dead retry orchestrators still ship in the bundle.** `src/model-fallback.ts:withFallback` (~266 LOC of full circuit-breaker + provider chain) and `src/provider-fallback.ts:ProviderChain` (~183 LOC). `getProviderHealthStatus` is the only export consumed, and `recordSuccess/recordFailure` is never called, so its persisted health file is always empty. If anyone wires them up later not knowing the inline `routes/chat.ts` cascade exists, you get a fifth and sixth retry layer.

7. **Anthropic CLI proxy path collapses message arrays to a single user prompt.** `src/anthropic-client/stream-cli.ts:368` writes one `fullPrompt` to stdin; `serializePriorTurns` (`stream-cli.ts:31`) is the manual workaround. The cold-spawn (`:173-252`) and warm-pool (`:111-143`) branches each carry their own copy of the prompt-building logic — already noted in memory as a divergence point.

8. **Codex `previousResponseId` is tracked in two competing stores.** `src/codex-session.ts:32` (in-memory Map, used by legacy `agent-codex/run-http.ts`) and `op.canonical.providerState.providerPayload.previousResponseId` on disk (used by canonical `CodexAdapter`). A conversation that migrates between paths mid-stream silently breaks its response chain.

9. **`src/codex-session.ts` and `src/codex-payload-policy.ts` have zero import sites.** Despite being referenced in the architecture map above, they have no callers — confirmed orphans. The "two competing stores" finding is therefore actually "one store and one ghost"; the ghost is what would activate if anyone ever calls back into legacy codex. Demoted from collision to dead-code, but worth fixing both at once.

10. **The WS chat handler self-loops via HTTP.** `src/server/lifecycle.ts:287` makes the WS `chat` handler `fetch http://127.0.0.1:<port>/api/chat` rather than dispatching directly. Every WS chat message pays the HTTP entry cost twice (parse, header round-trip, lock acquire). In-code comment acknowledges this is structural and "should be replaced by direct canonical-op subscription."

---

## Phase 1 — Map the Territory

### 1.1 Entry points

Files that initiate an agent run, tool call, or provider request. Format: `path:line — function — trigger → first orchestrator call`.

#### HTTP routes (`src/server.ts` → `src/server/request-handler.ts`)

| Path:line | Function | Trigger | Calls into |
|---|---|---|---|
| [src/routes/chat.ts:28](src/routes/chat.ts#L28) | `handleChatRoutes` (`POST /api/chat`) | Main user chat — SSE response | `prepareAgentRequest` → `runChatViaCanonical` (canonical-loop) or legacy `runAgent` fallback at [src/routes/chat.ts:435](src/routes/chat.ts#L435) |
| [src/routes/chat.ts:21](src/routes/chat.ts#L21) | `handleAutoDelegateRoutes` | `/api/chat/auto-delegate/*` | `delegateMessageToWorker` → worker pool |
| [src/routes/chat.ts:25](src/routes/chat.ts#L25) | `handleCompactRoute` | `/api/chat/compact` | Conversation compactor (no provider call) |
| [src/routes/chat/delegation-handoff.ts:98](src/routes/chat/delegation-handoff.ts#L98) | `runDelegationHandoff` | Triggered inside `/api/chat` when `routeMessage` returns `delegate` | `runAgent` (text-only handoff) + `delegateMessageToWorker` |
| `src/routes/chat/jarvis-redirect.ts:tryWorkerRedirect` | called from [src/routes/chat.ts:141](src/routes/chat.ts#L141) | Worker redirect message detection | `workers/pool.redirectOp` |
| [src/routes/mcp.ts:77](src/routes/mcp.ts#L77) | `handleMcpRoutes` (`POST /api/mcp/call`) | MCP bridge subprocess invokes a tool | `tool-executor.executeToolCalls` directly (no LLM) |
| [src/routes/mcp.ts:65](src/routes/mcp.ts#L65) | `handleMcpRoutes` (`GET /api/mcp/tools`) | MCP bridge tool-list query | none (metadata only) |
| [src/routes/autopilot.ts:27](src/routes/autopilot.ts#L27) | `handleAutopilotRoutes` (`POST /api/autopilot/start`) | UI / curl start autopilot | `autopilot/start.startAutopilot` → `autopilot/loop.runAutopilotLoop` → `autopilot/round-agent.runAutopilotRound` → `runAgent` |
| `src/routes/agents.ts` | `handleAgentRoutes` | Sub-agent control | `agency/handler.Handler` (legacy `runAgent` inside) |
| `src/routes/sessions.ts:13+` | `handleSessionRoutes` | Session CRUD; `/auto-summarize` calls compactor | mostly no provider |

Non-entry routes (config, files, health, security, etc.) are explicitly excluded.

#### WebSocket transports

| Path:line | Function | Trigger | Calls into |
|---|---|---|---|
| [src/chat-ws.ts:49](src/chat-ws.ts#L49) → wired in [src/server/lifecycle.ts:264](src/server/lifecycle.ts#L264) | `setupChatWebSocket` (`onChat` at line 269) | inbound `type: "chat"` WS frame | Self-loops via `fetch http://127.0.0.1:<port>/api/chat` at [src/server/lifecycle.ts:287](src/server/lifecycle.ts#L287) → re-enters chat route → canonical-loop |
| [src/chat-ws.ts:203](src/chat-ws.ts#L203) | `reconnect_op` handler | Client WS reconnect | `canonical-loop/index.reconnectOp` (replay only) |
| [src/chat-ws.ts:278](src/chat-ws.ts#L278) | `cancel_op` handler | UI cancel | `canonical-loop/index.opCancel` |
| [src/chat-ws.ts:322](src/chat-ws.ts#L322) | `inject` handler | Mid-turn user message | `agent-loop/inject-queue.pushInject` |
| [src/chat-ws.ts:373](src/chat-ws.ts#L373) | `agent-redirect` handler | UI redirect | `workers/pool.redirectOp` or `agency/handler.redirectAgent` |
| [src/chat-ws.ts:415](src/chat-ws.ts#L415) | `agent-control` handler | Pause/resume/cancel sub-agent | `workers/pool.killOp` / `autopilot/loop.requestStop` |
| `src/voice/audio-ws.ts:setupVoiceWebSocket` → `voiceTurnRunner` at [src/server/lifecycle.ts:76](src/server/lifecycle.ts#L76) | `/ws/voice` audio frames + STT final | After STT yields a final transcript | `prepareAgentRequest` → `runAgent` (legacy path, voice_visual tool only) |

#### Bridges (inbound external)

| Path:line | Function | Trigger | Calls into |
|---|---|---|---|
| [src/whatsapp-bridge.ts:44](src/whatsapp-bridge.ts#L44) → bound in [src/server/bootstrap-bridges.ts:305](src/server/bootstrap-bridges.ts#L305) | `WhatsAppBridge.onMessage` | WhatsApp inbound | `bridgeMessageHandler` → `prepareAgentRequest` → `runChatViaCanonical` |
| [src/telegram-bridge.ts:56](src/telegram-bridge.ts#L56) → bound in [src/server/bootstrap-bridges.ts:306](src/server/bootstrap-bridges.ts#L306) | `TelegramBridge.onMessage` | Telegram inbound | same |
| [src/server/bootstrap-bridges.ts:56](src/server/bootstrap-bridges.ts#L56) | `bridgeMessageHandler` | Shared bridge dispatcher | `runChatViaCanonical` |

#### Scheduled / background

| Path:line | Function | Trigger | Calls into |
|---|---|---|---|
| `src/cron-service.ts` (+ [src/server/background-jobs.ts:82](src/server/background-jobs.ts#L82)) | `cronService.onExecute` | Cron tick fires mission | `prepareAgentRequest` → `runAgent` (legacy; not canonical) |
| [src/server/background-jobs.ts:208](src/server/background-jobs.ts#L208) | `registerWorkerRunner` | App-builder worker | `resolveProvider` → `runAgent` |
| [src/server/background-jobs.ts:328](src/server/background-jobs.ts#L328) | `runDreamCheck` | 2 h memory dream | `resolveProvider` → `runAgent` |
| [src/server/background-jobs.ts:247](src/server/background-jobs.ts#L247) | `runMemBg` | 6 h memory backfill | `MemoryOrchestrator.runBackground` (no provider call) |
| `src/autopilot/loop.ts:runAutopilotLoop` → [src/autopilot/round-agent.ts:60+](src/autopilot/round-agent.ts#L60) | per-round | `POST /api/autopilot/start` | `runAgent` |
| [src/agency/handler.ts:115,313](src/agency/handler.ts#L313) (`runAgentAsync`) | Sub-agent spawn | tool calls `agent_spawn` / `delegate` | `runAgent` |
| [src/agents/invoke.ts:45](src/agents/invoke.ts#L45) | `invokeAgent` (intended single canonical door, **see Risk Register**) | Programmatic spawn | `Handler.spawnAgent` → `runAgent` |
| [src/workers/worker-entry.ts:220](src/workers/worker-entry.ts#L220) | Worker subprocess `assign-op` | Parent pool stdin IPC | `runAgent` directly in subprocess |

#### CLI / startup

| Path:line | Function | Trigger | Calls into |
|---|---|---|---|
| [src/index.ts:108-132](src/index.ts#L108) | Top-level boot | `node dist/index.js` | `startServer(config)` from `src/server.ts` |
| [src/index.ts:121-130](src/index.ts#L121) | `--login` flag | CLI arg | `auth.startOAuthLogin` only |

#### Not entry points (clarifications)

- `src/ipc-channel.ts` — generic framed Unix-socket library, no agent run.
- `src/integrations.ts` — registry of integration objects, not a handler.
- `src/llm-dispatch.ts:118,134` — single-shot completion helper for memory subsystems. Direct `fetch` to provider APIs, bypasses agent loops entirely. Counted as a separate "side channel" path (§1.2.5).
- `src/classifiers/vision-entity-extract.ts:104,156`, `src/memory-reranker.ts:110,141`, `src/video-summary.ts:156`, `src/image-tools.ts:51,87` — all direct provider `fetch` calls, side channels, not chat entries.

### 1.2 Orchestration paths

#### 1.2.1 Canonical chat path (post-2026-05-07 consolidation)

```
HTTP /api/chat                              (routes/chat.ts:28)
WS  /ws/chat type:"chat"                    (chat-ws.ts:333) ── self-loop fetch ─┐
WhatsApp inbound  (bootstrap-bridges.ts:305)                                     │
Telegram inbound  (bootstrap-bridges.ts:306)                                     │
        ▼                                                                        │
prepareAgentRequest()         (agent-request/prepare-request.ts)                 │
        │                                                                        │
        ▼  CANONICAL_CHAT_PROVIDERS ⊇ {anthropic,codex,local,                    │
        │   ollama-cloud,xai,openai,gemini,custom}                              │
        ▼  routes/chat.ts:296  await import("../canonical-loop/index.js")  ◀────┘
runChatViaCanonical()          (canonical-loop/chat-runner.ts:277)
        │   builds op + writeOp; seeds op_messages with history
        │   registers per-op adapter via registerAdapterForOp
        │   registers per-op tool dispatcher via makeChatToolDispatcher
        ▼
canonicalLoopEntry(op)         (canonical-loop/index.ts:264)
        ▼
enqueueOp + pumpScheduler      (canonical-loop/scheduler.ts)
        ▼
runWorker / driveTurn          (canonical-loop/worker.ts, turn-loop.ts:58)
        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ Per-op adapter (resolveAdapterFactory)                              │
   ├─────────────────────────────────────────────────────────────────────┤
   │ AnthropicAdapter  (canonical-loop/adapters/anthropic.ts:150)        │
   │   → defaultAnthropicTransport()  (anthropic-transport.ts:28,51)     │
   │   → streamAnthropicResponse  (anthropic-client/stream.ts:13)        │
   │       ├─ sk-ant-api03-* → streamViaAPI (stream-api.ts:39)           │
   │       │     fetch api.anthropic.com/v1/messages                     │
   │       └─ cli/oauth/sk-ant-oat → streamViaCliWithTools               │
   │             (stream-cli.ts:337  spawn "claude" subprocess)          │
   │                                                                     │
   │ CodexAdapter   (canonical-loop/adapters/codex.ts:31)                │
   │   → defaultCodexTransport()  (codex-transport.ts:27,47)             │
   │   → CodexCliAdapter.stream() (providers/adapters/codex-cli.ts:21)   │
   │   → streamCodexResponse()    (codex-client.ts:87,157)               │
   │       fetch https://chatgpt.com/backend-api/codex/responses         │
   │                                                                     │
   │ OpenAICompatAdapter  (canonical-loop/adapters/openai-compat.ts:55)  │
   │   → ollamaHttpAdapter.stream  (providers/adapters/ollama-http.ts)   │
   │       extends OpenAIHttpAdapter (providers/adapters/openai-http.ts) │
   │   baseURL routing at openai-compat.ts:461-473                       │
   └─────────────────────────────────────────────────────────────────────┘

Tools  → canonical-loop/chat-tool-dispatcher.ts:55
       → tool-executor.executeToolCalls   (single owner)
```

#### 1.2.2 Legacy `runAgent` path (still alive for non-chat orchestration and as chat fallback)

```
runAgent(userMessage, history, opts)   (agent.ts:42)
        │
        ├── env LAX_UNIFIED_LOOP=1 → agent-loop/run.ts (Phase-1 unified loop)
        │
        ├── opts.provider === "codex"     → runCodexAgent  (agent-codex.ts shim → agent-codex/run-http.ts:31)
        │                                   → providers.requireAdapter("codex-cli")
        │                                   → CodexCliAdapter.stream → streamCodexResponse
        │
        ├── opts.provider === "anthropic" → runAnthropicAgent  (providers/run-anthropic.ts:20)
        │                                   → requireAdapter("anthropic-cli" or "anthropic-http")
        │                                   → streamViaAPI or streamViaCliWithTools
        │
        └── else                          → runStandardAgent (providers/run-standard.ts:20)
                                            providerURLs[…] in run-standard.ts:37-46
                                            → requireAdapter("openai-http"|"ollama-http")
                                            → new OpenAI({apiKey,baseURL}).chat.completions.create
```

Callers still on this legacy entry:

- `routes/chat.ts:435` — fallback when canonical disabled/ineligible
- `routes/chat/delegation-handoff.ts:98` — delegation text response
- `server/background-jobs.ts:118,233,349,358` — cron, worker-session, dream
- `server/lifecycle.ts:205` — voice turn runner (entire voice path)
- `autopilot/round-agent.ts` — every autopilot round
- `agency/handler.ts:313` — sub-agent / FieldAgent spawns
- `workers/worker-entry.ts:220` — every worker subprocess op

#### 1.2.3 Worker-pool delegation

```
delegateMessageToWorker()           (routing/delegate-worker.ts:24)
   ▼
workers/pool.submitOp               (workers/pool.ts)
   │ spawns: node dist/workers/worker-entry.js
   │ assign-op via stdin IPC
   ▼
workers/worker-entry.ts:65 handleAssignOp → runAgent  (legacy path #1.2.2, in subprocess)
```

#### 1.2.4 MCP-tool path

```
Claude CLI (subprocess spawned by anthropic-cli adapter)
   └─ --mcp-config lax.json
        └─ spawn node mcp-bridge.js
              └─ HTTP GET  /api/mcp/tools       (routes/mcp.ts:65)
              └─ HTTP POST /api/mcp/call        (routes/mcp.ts:77)
                    ▼
              tool-executor.executeToolCalls   (single owner — NO model call)
```

#### 1.2.5 Side-channel direct provider calls (bypass both loops)

| Caller | File:line | Endpoint |
|---|---|---|
| `llm-dispatch` (memory resolver/extract/hyde, decomposer) | [src/llm-dispatch.ts:118](src/llm-dispatch.ts#L118) | `api.anthropic.com/v1/messages` |
| same | [src/llm-dispatch.ts:134](src/llm-dispatch.ts#L134) | `api.openai.com/v1/chat/completions` |
| memory reranker | [src/memory-reranker.ts:110](src/memory-reranker.ts#L110),[:141](src/memory-reranker.ts#L141) | anthropic + openai |
| vision entity extract | [src/classifiers/vision-entity-extract.ts:104](src/classifiers/vision-entity-extract.ts#L104),[:156](src/classifiers/vision-entity-extract.ts#L156) | openai + anthropic |
| video summary | [src/video-summary.ts:156](src/video-summary.ts#L156) | anthropic |
| image generation tool | [src/image-tools.ts:51](src/image-tools.ts#L51),[:87](src/image-tools.ts#L87) | api.x.ai, api.openai.com (images) |
| curate classifier, EOT write, llm classifier, worker-redirect classifier, voice-llm, classify-with-llm | see §1.3 call-sites | direct call to `streamAnthropicResponse`/`streamCodexResponse` |

These each re-implement auth resolution, error handling, and telemetry independently.

#### 1.2.6 Streaming layer

- SSE on `POST /api/chat` via `sseWrite` (`server-utils.ts`)
- Same `ServerEvent` ALSO mirrored onto `chat-ws.onEvent` ([src/routes/chat.ts:170](src/routes/chat.ts#L170)) — intentional pairing
- `bg_op_*` events broadcast via `chat-ws.broadcastAll` ([src/chat-ws.ts:64-74](src/chat-ws.ts#L64), [src/autopilot/loop.ts:44](src/autopilot/loop.ts#L44))
- `/ws/voice` is a separate transport with its own framing

#### Redundancy callouts

1. **Two parallel Anthropic entry paths** (canonical and legacy `runAgent`) — both ultimately call the same `stream-api.streamViaAPI` or `stream-cli.streamViaCliWithTools`. Two callers, one transport.
2. **Two parallel Codex entry paths** — `agent-codex/run-http.ts` and `canonical-loop/adapters/codex.ts` both wrap `streamCodexResponse`.
3. **Two parallel OpenAI-compat paths** — `providers/run-standard.ts` and `canonical-loop/adapters/openai-compat.ts` both feed `new OpenAI({apiKey,baseURL}).chat.completions.create`.
4. **Side-channel `fetch` outside both loops** — `llm-dispatch`, `memory-reranker`, `vision-entity-extract`, `video-summary`. Auth, retry, telemetry, threat scanning are reimplemented or absent here.
5. **Tool execution is single-owner** — every path funnels into `src/tool-executor.ts:executeToolCalls`. No parallel runtime found.
6. **The WS chat "self-loop"** — every WS chat message round-trips through HTTP. Comment marks it as known structural debt.
7. **Two routing gates before any provider call** — `routing/router.routeMessage` decides inline-vs-worker ([src/routes/chat.ts:145](src/routes/chat.ts#L145)), then canonical eligibility is re-checked ([src/routes/chat.ts:276-285](src/routes/chat.ts#L276)). Two independent gates per message.
8. **Sub-agent spawn has three doors** — `agency/handler.spawnAgent`, `agents/invoke.invokeAgent`, and the tools `agent_spawn` / `delegate`. `invoke.ts:1-50` says it was intended as the single canonical door but the others still exist.

### 1.3 Adapter inventory

There are **three distinct adapter architectures** stacked on each other. Each tier translates event shapes.

- **T1 — Legacy stream functions.** `streamAnthropicResponse`, `streamCodexResponse`, `streamViaAPI`, `streamViaCliWithTools`. Async generators yielding ad-hoc `StreamEvent`. Still imported directly by ≥6 classifier/voice/memory modules.
- **T2 — `BaseAdapter` registry.** `src/providers/adapter/{base-adapter,registry,types}.ts`. Five concrete adapters: `anthropic-http`, `anthropic-cli`, `codex-cli`, `openai-http`, `ollama-http`. Registered via side-effect import of `src/providers/adapters/index.ts`. Thin wrappers calling T1.
- **T3 — Canonical-loop adapters.** `src/canonical-loop/adapter-contract.ts`. Implementations: `AnthropicAdapter`, `CodexAdapter`, `OpenAICompatAdapter`. Anthropic/Codex transports call T1; OpenAI-compat transport calls T2's `ollamaHttpAdapter`. So T3 depends on T2 for OpenAI-compat; T2 and T3 both depend on T1.

#### Adapter 1 — Anthropic HTTP (real API key)

- T1: [src/anthropic-client/stream.ts:13](src/anthropic-client/stream.ts#L13) routes; [src/anthropic-client/stream-api.ts:5](src/anthropic-client/stream-api.ts#L5) `streamViaAPI`. Helpers: [src/anthropic-client/request.ts:7](src/anthropic-client/request.ts#L7) (module-level `_toolCallSeq`).
- T2: [src/providers/adapters/anthropic-http.ts:20](src/providers/adapters/anthropic-http.ts#L20) `AnthropicHttpAdapter`.
- T3: [src/canonical-loop/adapters/anthropic.ts:150](src/canonical-loop/adapters/anthropic.ts#L150) `AnthropicAdapter`; transport at [src/canonical-loop/adapters/anthropic-transport.ts:28,51](src/canonical-loop/adapters/anthropic-transport.ts#L28).
- T1 direct callers (bypass both adapter layers): [memory/curate-classifier.ts:189](src/memory/curate-classifier.ts#L189), [memory/end-of-turn-write.ts:133](src/memory/end-of-turn-write.ts#L133), [routing/llm-classifier.ts:82](src/routing/llm-classifier.ts#L82), [routing/worker-redirect-classifier.ts:119](src/routing/worker-redirect-classifier.ts#L119), [voice/voice-llm.ts:75](src/voice/voice-llm.ts#L75), [classifiers/classify-with-llm.ts:174](src/classifiers/classify-with-llm.ts#L174).

#### Adapter 2 — Anthropic CLI (subscription / OAuth)

- T1: [src/anthropic-client/stream-cli.ts:63](src/anthropic-client/stream-cli.ts#L63) `streamViaCliWithTools`. Two sub-paths: cold spawn ([:337](src/anthropic-client/stream-cli.ts#L337)) and warm pool ([src/anthropic-client/warm-pool.ts:streamViaWarmPool](src/anthropic-client/warm-pool.ts)).
- T2: [src/providers/adapters/anthropic-cli.ts:22](src/providers/adapters/anthropic-cli.ts#L22).
- T3: shared with Adapter 1 (the `AnthropicAdapter` dispatches by token shape inside `streamAnthropicResponse`).
- **Single-prompt collapse:** CLI accepts one text prompt via stdin ([:368](src/anthropic-client/stream-cli.ts#L368)). Message arrays flattened by `extractUserPrompt` ([src/anthropic-client/request.ts:12](src/anthropic-client/request.ts#L12)). Cross-turn context manually re-serialized via `serializePriorTurns` ([:31](src/anthropic-client/stream-cli.ts#L31)) and prepended at [:252](src/anthropic-client/stream-cli.ts#L252). Cold-spawn block ([:173-252](src/anthropic-client/stream-cli.ts#L173)) and warm-pool block ([:111-143](src/anthropic-client/stream-cli.ts#L111)) are near-copies — drift risk.

#### Adapter 3 — Codex (ChatGPT subscription / Responses API)

- T1: [src/codex-client.ts:87](src/codex-client.ts#L87) `streamCodexResponse`. POSTs to `chatgpt.com/backend-api/codex/responses`.
- Helpers: `src/codex-message-convert.ts` (`convertMessagesToInput`, `encodeToolCallId`), `src/codex-payload-policy.ts` (**0 imports — dead**, §2.6), `src/codex-session.ts` (**0 imports — dead**).
- T2: [src/providers/adapters/codex-cli.ts:18](src/providers/adapters/codex-cli.ts#L18).
- T3: [src/canonical-loop/adapters/codex.ts:31](src/canonical-loop/adapters/codex.ts#L31); transport at [src/canonical-loop/adapters/codex-transport.ts:27](src/canonical-loop/adapters/codex-transport.ts#L27) — **instantiates T2's `CodexCliAdapter` rather than calling T1 directly**, so Codex goes T3 → T2 → T1.
- Cancellation gap: `streamCodexResponse` has its own 90s silence timer ([:210-220](src/codex-client.ts#L210)) but no caller-supplied `signal` param. T3 mints an `AbortController` but it terminates only via stream-reader interruption.

#### Adapter 4 — OpenAI / xAI / Gemini / custom (Chat Completions wire format)

- T2: [src/providers/adapters/openai-http.ts:23](src/providers/adapters/openai-http.ts#L23) `OpenAIHttpAdapter` — uses the official `openai` SDK. The only adapter that inlines its provider call code (no separate T1 layer).
- T3: [src/canonical-loop/adapters/openai-compat.ts:55](src/canonical-loop/adapters/openai-compat.ts#L55) `OpenAICompatAdapter`. Calls `ollamaHttpAdapter.stream` at [:200](src/canonical-loop/adapters/openai-compat.ts#L200) — **always**, even for non-Ollama providers (works because Ollama adapter is a no-op subclass, but semantically wrong).

#### Adapter 5 — Ollama (local) / Ollama Cloud (Turbo)

- T2: [src/providers/adapters/ollama-http.ts:13](src/providers/adapters/ollama-http.ts#L13) `extends OpenAIHttpAdapter` — pure subclass; zero behavior delta.
- **Cloud routing lives in `src/ollama-cloud.ts`**, a sidecar with module-level `cached: CloudState | null` ([:44](src/ollama-cloud.ts#L44)). Canonical-loop reads it at [src/canonical-loop/chat-runner.ts:346-350](src/canonical-loop/chat-runner.ts#L346). Legacy `runStandardAgent` has NO `"ollama-cloud"` entry in its `providerURLs` table ([src/providers/run-standard.ts:37-46](src/providers/run-standard.ts#L37)) — it would fall through to `api.openai.com/v1`. **Cloud Ollama works only on the canonical path.**

#### Cross-cutting inconsistencies (should be uniform but aren't)

1. **Three event-shape contracts in one process.** T1 `StreamEvent`, T2 `StreamChunk`, T3 `AdapterReport`. Field naming drifts each translation hop. Concrete bug surface: Anthropic prompt-cache token fields (`cacheReadTokens`/`cacheCreateTokens`) survive T3 transport ([src/canonical-loop/adapters/anthropic-transport.ts:85-91](src/canonical-loop/adapters/anthropic-transport.ts#L85)) but are **dropped at the T2 boundary** ([src/providers/adapters/anthropic-cli.ts:67-70](src/providers/adapters/anthropic-cli.ts#L67), [src/providers/adapters/anthropic-http.ts:64-67](src/providers/adapters/anthropic-http.ts#L64)) — prompt-cache cost reporting broken on any path that goes legacy-T2.
2. **Request shape — single prompt vs message array.** Only `anthropic-cli` flattens to a single prompt; everyone else keeps message arrays. Captured in memory note.
3. **Auth resolution scattered.** `getAnthropicApiKey()` is called from T1 direct callers (5+ sites), the T3 transport ([:36](src/canonical-loop/adapters/anthropic-transport.ts#L36)), and `llm-dispatch.ts:105-128` reimplements an entirely separate Anthropic POST.
4. **Token-shape detection split.** `usesAnthropicSubscriptionAuth` from `src/anthropic-models.ts` is the shared helper, used by [providers/run-anthropic.ts:58](src/providers/run-anthropic.ts#L58), [agent-loop/run.ts:49](src/agent-loop/run.ts#L49), [anthropic-client/stream.ts:21](src/anthropic-client/stream.ts#L21). But `llm-dispatch.ts:112-114` does ad-hoc `startsWith("oauth:")` / `startsWith("sk-ant-api")` — won't pick up new prefixes.
5. **Retry logic spread across ≥5 places.** See §2.7 Pattern 3.
6. **Tool-call serialization in 4 different inlines.** `src/providers/shared/tool-shape.ts:toOpenAITools/toAnthropicTools` exists; only [openai-http.ts:40](src/providers/adapters/openai-http.ts#L40) uses it. Every other adapter inlines its own translation: [anthropic-http.ts:29-34](src/providers/adapters/anthropic-http.ts#L29), [anthropic-cli.ts:31-36](src/providers/adapters/anthropic-cli.ts#L31), [codex-cli.ts:22-27](src/providers/adapters/codex-cli.ts#L22), [canonical-loop/adapters/openai-compat.ts:80-84](src/canonical-loop/adapters/openai-compat.ts#L80), [canonical-loop/adapters/anthropic.ts:378-384](src/canonical-loop/adapters/anthropic.ts#L378).
7. **CLI parser inside `stream-cli.ts:411-489`** parses two concurrent shapes (`stream_event` partial-messages + `assistant` full-blocks) plus the `result` summary. Special-cases `mcp__` prefix at [:471](src/anthropic-client/stream-cli.ts#L471) to avoid double-execution.
8. **OpenAI-compat in canonical uses `ollamaHttpAdapter` for everything** ([:200](src/canonical-loop/adapters/openai-compat.ts#L200)) — semantically wrong; the registered `openaiHttpAdapter` is never reached from the canonical path.
9. **Abort/cancellation has three different teardown semantics.** T1 anthropic-cli kills subprocess SIGTERM→SIGKILL ([stream-cli.ts:350-362](src/anthropic-client/stream-cli.ts#L350)). T1 codex has internal silence timer only ([codex-client.ts:210-220](src/codex-client.ts#L210)) — no caller-supplied signal. T2 openai-http calls `stream.controller.abort()` ([openai-http.ts:81-83](src/providers/adapters/openai-http.ts#L81)). T3 mints per-turn `AbortController` ([anthropic.ts:186](src/canonical-loop/adapters/anthropic.ts#L186), [codex.ts:52](src/canonical-loop/adapters/codex.ts#L52)).
10. **Logging is layer-local.** T1 each generator calls `createLogger`. T2 adapters don't log. T3 has its own `soak-metrics.ts`. `retry-telemetry.ts:logRetry` is called only from loop and route layers — never from T2/T3 adapters.
11. **Hardcoded timeouts inside T1.** [stream-api.ts:42](src/anthropic-client/stream-api.ts#L42) `AbortSignal.timeout(60_000)`; [codex-client.ts:161,210](src/codex-client.ts#L161) 120s connect + 90s silence; codex retry max 3 ([:154](src/codex-client.ts#L154)). Callers can't configure any of these.

### 1.4 Shared state and side effects

| State | File:line | Touched by | Cross-orchestrator? |
|---|---|---|---|
| `_localNoToolModels: Set<string>` | [src/providers/types.ts:35](src/providers/types.ts#L35) | Mutated by [providers/adapters/openai-http.ts:54](src/providers/adapters/openai-http.ts#L54) (legacy + unified) and read/mutated indirectly by [canonical-loop/adapters/openai-compat.ts:33,110](src/canonical-loop/adapters/openai-compat.ts#L33) | **★** Yes — single Set, two writer towers, never reset |
| Adapter registry `_adapters`, `_override` | [src/providers/adapter/registry.ts:16,24](src/providers/adapter/registry.ts#L16) | Boot at [providers/adapters/index.ts:21-25](src/providers/adapters/index.ts#L21) (idempotent). `_override` mutated by [agent-loop/eval/replay-adapter.ts:64](src/agent-loop/eval/replay-adapter.ts#L64) | Yes (eval path can override what production reads) |
| `_toolCallSeq: number` | [src/anthropic-client/request.ts:7](src/anthropic-client/request.ts#L7) | Mutated at [stream-cli.ts:487,520,552](src/anthropic-client/stream-cli.ts#L487). Process-wide monotonic; not per-session | **Needs verification** — parallel CLI chats share counter |
| Warm pool `pool`, `waiters`, `evictTimer` | [src/anthropic-client/warm-pool.ts:120-122](src/anthropic-client/warm-pool.ts#L120) | Shared across every chat session that hits the CLI path | Yes (every CLI-path session) |
| `_npmGlobalBin: string \| null` | [src/anthropic-client/cli-path.ts:7](src/anthropic-client/cli-path.ts#L7) | Lazy cache for both cold-spawn and warm pool | Yes |
| `cached: CloudState \| null` | [src/ollama-cloud.ts:44](src/ollama-cloud.ts#L44) | Mutated by [routes/settings/providers.ts:55,149](src/routes/settings/providers.ts#L55); read by canonical only | Canonical-only |
| `sessions: Map<string, CodexSession>` | [src/codex-session.ts:32](src/codex-session.ts#L32) | **No actual import sites** — orphaned (see §2.6) | Dormant collision risk |
| Anthropic OAuth tokens (`~/.lax/anthropic-auth.json`) | [src/auth-anthropic.ts:69,107](src/auth-anthropic.ts#L69) | Refresh: `auth-refresh.ts:21` timer; read by ≥6 callers independently | Yes |
| `healthMap` (`~/.lax/provider-health.json`) | [src/model-fallback.ts:72,84](src/model-fallback.ts#L72) | **Read by status routes only**; no chat path writes it | Likely dead (§2.6) |
| Canonical-loop singletons: `opAdapters`, `laneAdapters`, `opDispatchers`, `opTools`, `toolDispatcher` | [src/canonical-loop/runtime.ts:20-24](src/canonical-loop/runtime.ts#L20) | Registration from `chat-runner.ts:321,330,359` + `workers/tools.ts:292`. Cleanup is caller-driven via `unregister...ForOp(opId)` — no auto-clean | **Risk:** leak on abnormal termination |
| Scheduler `queue`, `active`, `activeByLane`, `pumping` | [src/canonical-loop/scheduler.ts:35-38](src/canonical-loop/scheduler.ts#L35) | Lane-concurrency caps | Canonical-only |
| `HEARTBEATS: Map<string, NodeJS.Timeout>` | [src/canonical-loop/worker.ts:49](src/canonical-loop/worker.ts#L49) | Worker heartbeats | Canonical-only |
| `active: CanonicalBus = new InProcessBus()` | [src/canonical-loop/bus.ts:42](src/canonical-loop/bus.ts#L42) | EventEmitter singleton; subscribed by control-api, chat-runner, session-bridge-observer, soak-metrics | Canonical-only |
| Soak metrics `records`, `warnedOnce` | [src/canonical-loop/soak-metrics.ts:56-57](src/canonical-loop/soak-metrics.ts#L56) | Aggregated telemetry; appends to disk | Canonical-only |
| `pendingLogin`, `callbackServer`, `callbackTimeout` | [src/auth.ts:108-110](src/auth.ts#L108) | OpenAI/Codex OAuth flow singletons | Boot/login only |

#### Disk writes during a chat turn

| Path | Writer | Comment |
|---|---|---|
| `~/.lax/operations/<opId>/operation.json` | [workers/op-store.ts:24](src/workers/op-store.ts#L24) `writeOp` — called by legacy worker pool AND by canonical-loop ([canonical-loop/op-persist.ts:67](src/canonical-loop/op-persist.ts#L67), [canonical-loop/index.ts:278](src/canonical-loop/index.ts#L278), [canonical-loop/chat-runner.ts:309](src/canonical-loop/chat-runner.ts#L309)) | **★** Two writers. `op-persist.ts:51` `persistOpKeepingSignals` is the canonical-side RMW guard; legacy pool has no equivalent. PRD §12 expects `op.canonical.*` to be canonical-owned. |
| `~/.lax/operations/<opId>/canonical-events.jsonl` | [canonical-loop/store.ts:77](src/canonical-loop/store.ts#L77) `appendCanonicalEvent` (sole writer: `event-emitter.ts:27`) | Append-only |
| `~/.lax/operations/<opId>/op-turns/<idx>.json` | [canonical-loop/store.ts:129](src/canonical-loop/store.ts#L129) `insertOpTurn` (sole writer: `checkpoint.ts:commitTurn`) | Atomic tmp+rename |
| `~/.lax/operations/<opId>/op-messages.jsonl` | [canonical-loop/store.ts:205](src/canonical-loop/store.ts#L205) `appendOpMessage` (writers: `chat-runner.ts:seedOpMessages`, `checkpoint.ts:commitTurn`) | Append-only |
| `~/.lax/operations/<opId>/events.jsonl` | `src/workers/event-log.ts` (legacy) | Coexists with canonical-events.jsonl in same dir |
| `~/.lax/anthropic-auth.json` | [auth-anthropic.ts:69](src/auth-anthropic.ts#L69) | OAuth refresh during chat |
| `~/.lax/auth.json` | `src/auth.ts` | OpenAI/Codex OAuth |
| `~/.lax/tmp/mcp-*.json` | [stream-cli.ts:326](src/anthropic-client/stream-cli.ts#L326), [warm-pool.ts:116](src/anthropic-client/warm-pool.ts#L116) | Per-turn (cold, deleted after run) vs per-session (warm, deleted on exit). Different naming, potential leak on hard kill |
| `workspace/canonical-loop-soak-${HOST}.jsonl` | [canonical-loop/soak-metrics.ts:79](src/canonical-loop/soak-metrics.ts#L79) | Rollout soak file (per memory note) |
| `~/.lax/provider-health.json` | [model-fallback.ts:84](src/model-fallback.ts#L84) | Likely dead writer (see §2.6) |

#### Env / process-state writes (chat path)

- `src/voice/tier4/voice-clone-loader.ts:31-33` writes `process.env.HF_HOME`, `TRANSFORMERS_CACHE`, `HUGGINGFACE_HUB_CACHE`. Voice only.
- Subprocess env populated via `npmAugmentedEnv()` ([cli-path.ts](src/anthropic-client/cli-path.ts)) and per-MCP-bridge injection ([stream-cli.ts:307-311](src/anthropic-client/stream-cli.ts#L307), [warm-pool.ts:108-114](src/anthropic-client/warm-pool.ts#L108)). Mutates spawn env, not parent process.
- No other module-level `process.env` writes from chat-path code.

---

## Phase 2 — Find the Mess

### 2.5 Duplicate logic

#### Cluster 1 — Orchestration / agent-turn driver (the big one)

Three complete, parallel implementations of "the agent turn":

| Loop | Entry | LOC | Maturity |
|---|---|---|---|
| **A. Legacy per-provider** | [providers/run-standard.ts:20](src/providers/run-standard.ts#L20), [providers/run-anthropic.ts:20](src/providers/run-anthropic.ts#L20), [agent-codex/run-http.ts:31](src/agent-codex/run-http.ts#L31) | 411 + 378 + 500 | Live fallback / non-chat orchestration |
| **B. Unified middleware** | [agent-loop/run.ts:90](src/agent-loop/run.ts#L90) `runAgentTurn` | 451 | Gated on `LAX_UNIFIED_LOOP=1`, off by default ([agent.ts:65](src/agent.ts#L65)) |
| **C. Canonical** | [canonical-loop/turn-loop.ts:58](src/canonical-loop/turn-loop.ts#L58) `driveTurn`, [canonical-loop/chat-runner.ts:277](src/canonical-loop/chat-runner.ts#L277) `runChatViaCanonical` | 315 + 489 | Live for chat ops |

Shim files that are NOT duplicates, just re-exports:
- [src/agent.ts:42](src/agent.ts#L42) — `runAgent` (branches A/B by env flag, never C)
- `src/agent-codex.ts` (2 lines)
- `src/agent-providers.ts` (4 lines)
- `src/agent-request.ts` (3 lines)

Side-by-side duplicated middleware logic between loops A, B, and C:

| Concept | A: run-standard | A: run-anthropic | B: agent-loop | C: canonical |
|---|---|---|---|---|
| Per-turn token ceiling 500_000 | `:90,102-117` | `:67,79-95` | `middlewares/token-ceiling.ts:1-41` | absent |
| Per-turn wall-clock 180_000 vs canonical idle 600_000 | `:91` | `:68` | `middlewares/wall-clock-ceiling.ts:12` | `turn-loop.ts:101` (**different value**) |
| Mid-turn-evidence-stale window=3 | `checkStandardTurnSafetyCeilings` | `checkAnthropicTurnSafetyCeilings` | `middlewares/mid-turn-stale.ts` | absent |
| Heartbeat / onTurnRelease | `:96-99` | `:73-76` | `middlewares/heartbeat.ts:25-26` | absent (own `idle-stalled` mechanism) |
| `stripEphemeralMessages` between iters | `:119` | `:97` | `run.ts:164` | absent |
| `checkAndCompactAsync` | `:120` | `:98` | `run.ts:165` | replaced by `getOpMessages` replay |
| Drain subagent completion queue | `:132-138` | `:101-109` | `middlewares/subagent-drain.ts` | absent (interject only) |
| Force-tool-use regex | `:85-87` | `:62-64` | `middlewares/force-tool-use.ts` | absent — canonical never sets toolChoice |
| Loop detection (`checkToolLoops`) | `:337-346` | `:309-318` | `middlewares/loop-detection.ts:25-53` | absent |
| Dead-end (3 empty results → nudge) | `:370-379` | `:342-351` | `middlewares/dead-end.ts` | absent |
| Post-commit nudge | `:385-394` | `:355-365` | `middlewares/post-commit.ts` | absent |
| Post-turn detector stack | `:266-287` | `:235-259` | `middlewares/post-turn-detector.ts` | absent |
| Hallucination checks | `:291-303` | `:282-294` | `middlewares/hallucination-check.ts` | absent |
| Action-claim check | `:307-315` | `:264-272` | `middlewares/action-claim.ts` | absent |
| Self-check (unresolved errors) | `:318-323` | `:296-301` | `middlewares/self-check.ts` | absent |
| Pause/handoff for "please log in" | `:396-403` | `:367-374` | `middlewares/pause.ts` | absent |
| Context-overflow rescue (`forceCompact`) | `:216-224` | `:188-196` | `run.ts:247-255` | absent (canonical drops state on error) |
| Auto-route build_app | absent | `:219-233` | `middlewares/auto-build-app.ts` | absent |

Canonical (of-the-canonicals): `src/agent-loop/run.ts` is the *explicit intended unification* (head comment: "Replaces the per-provider loops … with a single body"). It has the cleanest design — single middleware stack, adapter dispatch. But it's gated and never carries chat traffic.

#### Cluster 2 — Provider adapters (two registries)

| Registry | Owner | Files |
|---|---|---|
| Legacy | [providers/adapter/registry.ts](src/providers/adapter/registry.ts) | `anthropic-cli.ts`, `anthropic-http.ts`, `codex-cli.ts`, `openai-http.ts`, `ollama-http.ts` |
| Canonical | [canonical-loop/runtime.ts:registerAdapterForOp](src/canonical-loop/runtime.ts) | `adapters/anthropic.ts`, `anthropic-transport.ts`, `codex.ts`, `codex-transport.ts`, `openai-compat.ts` |

Both ultimately call the same low-level transports (T1). See §1.3 for full layering.

#### Cluster 3 — Retry / fallback / circuit (three live + two dead orchestrators)

| File | What it does | Status |
|---|---|---|
| [src/auto-retry.ts:28](src/auto-retry.ts#L28) `withRetry` | Generic exponential-backoff | Used only by [tool-executor.ts:616](src/tool-executor.ts#L616) |
| `src/circuit-breaker.ts` (149 LOC) | Per-(session, tool) state machine | Used by [tool-executor.ts:21,638,640](src/tool-executor.ts#L21) |
| [src/model-fallback.ts:203](src/model-fallback.ts#L203) `withFallback` (266 LOC) | Provider-level fallback + circuit-breaker + persistent health | **Essentially dead** — `withFallback`, `buildFallbackChain`, `recordSuccess/Failure`, `isProviderAvailable` exported but never called. Only `getProviderHealthStatus` is consumed (status UI) — and the health map is always empty because no one records into it. |
| [src/provider-fallback.ts:96](src/provider-fallback.ts#L96) `ProviderChain` | Second simpler circuit-breaker | **`ProviderChain` class never instantiated.** `classifyProviderError` IS used ([routes/chat.ts:461](src/routes/chat.ts#L461)). |
| [src/routes/chat.ts:525-580](src/routes/chat.ts#L525) | Inline `[codex, anthropic, xai]` cascade | **Live.** The actual production fallback |
| `src/stream-reliability.ts` (172 LOC) | Stream retry/reconnect | Imported only by `test-suite.ts` (likely dead — §2.6) |
| [src/retry-telemetry.ts:49](src/retry-telemetry.ts#L49) `logRetry` | Append-only JSONL | Live, many call sites |

Divergence: `model-fallback.ts` keys transients off HTTP status codes only; `provider-fallback.classifyProviderError` keys off substring matches in error messages. Different cooldown/threshold semantics. Either would give a different answer for the same error.

#### Cluster 4 — Memory (15+ files — actually well-separated)

[src/memory.ts](src/memory.ts) is a 15-line shim → `src/memory/`. The `memory-*.ts` files at root are mostly distinct subsystems with single-purpose classes:

- `memory-graph.ts` (`MemoryGraphImpl`), `memory-importance.ts`, `memory-tiers.ts`, `memory-consolidation.ts`, `memory-compression.ts`, `memory-extract.ts`, `memory-hyde.ts`, `memory-resolver.ts`, `memory-reranker.ts`, `memory-mmr.ts`, `memory-dream.ts`, `memory-chunking.ts`, `narrative-memory.ts`, `proactive-memory.ts`, `associative-recall.ts`, `predictive-prefetch.ts`.
- `memory-orchestrator.ts` is a 13-line shim → `orchestrator/orchestrator.ts:111` `MemoryOrchestrator`.

**Note:** `src/orchestrator/` is the **memory** orchestrator (signal fusion / triage), NOT an agent-turn orchestrator. Despite the directory name implying overlap with `canonical-loop`/`agent-loop`, there is none — different problem domain.

Suspected duplication worth a deeper look (not confirmed): `src/memory/auto-extract.ts` vs `src/memory-extract.ts` (root). Both touch "extract facts from chunks." Needs verification.

#### Cluster 5 — Auth (shared OAuth skeleton)

- [src/auth.ts](src/auth.ts) (265 LOC) — OpenAI/Codex OAuth
- [src/auth-anthropic.ts](src/auth-anthropic.ts) (271 LOC) — Anthropic OAuth — same structural skeleton, different URLs/scopes/token files
- [src/auth-refresh.ts](src/auth-refresh.ts) (68 LOC) — Background timer for both
- [src/keychain.ts](src/keychain.ts) (328 LOC) — OS keychain integration (separate concern)

~80% structural overlap between `auth.ts` and `auth-anthropic.ts`. `generatePkce` is byte-identical. `loadTokens` / `refreshTokens` / OAuth callback skeleton same shape, different field optionality and URLs. Anthropic side adds `isAnthropicTokenExpired` helper and a `method: "token"` (manual setup token) path that `auth.ts` doesn't have. Not trivially mergeable, but the shared 70% is real duplication.

#### Cluster 6 — Security / RBAC

- `src/rbac.ts:20` defines `Role = "operator" | "user" | "readonly"` — **live** (imported by `tool-executor.ts:8`, `routes/agents.ts:475`).
- `src/security-rbac.ts:8` defines `EnhancedRole = "admin" | "operator" | "user" | "viewer" | "readonly"` — **0 imports**. Parallel role system; suspected stalled V2. Confirmed dead per §2.6.

#### Cluster 7 — Tool execution / SDK / interface

- [src/tool-executor.ts:711](src/tool-executor.ts#L711) `executeToolCalls` (768 LOC) — **single canonical owner**. All 5 callers route through this: [agent-codex/run-http.ts:445](src/agent-codex/run-http.ts#L445), [agent-loop/run.ts:343](src/agent-loop/run.ts#L343), [canonical-loop/chat-tool-dispatcher.ts:55](src/canonical-loop/chat-tool-dispatcher.ts#L55), [routes/mcp.ts:110](src/routes/mcp.ts#L110), [providers/run-anthropic.ts:334](src/providers/run-anthropic.ts#L334), [providers/run-standard.ts:362](src/providers/run-standard.ts#L362). **No forking.**
- `src/tool-sdk.ts` (196 LOC) — `defineTool()` helper. Live but separate concern. Imported only by `test-suite.ts` so worth verifying.
- `src/tool-interface.ts` (85 LOC) — duplicate of `tool-prompt-builder.ts` (the live one at `:22` is what `tools/registry-build.ts` imports). **Dead** per §2.6.
- `src/parallel-tools.ts` (121 LOC) — **0 imports outside test-suite**. `tool-executor.ts:740-757` re-implements parallel batching inline using `t.readOnly`/`t.concurrencySafe` flags. Drift trap if anyone re-introduces `executeParallel`.

#### Cluster 8 — Tool policy

`src/tool-policy.ts` (278) is the live `ToolPolicy` class; `src/tool-policy/` directory contains its split parts (`default-rules.ts`, `matchers.ts`, `types.ts`). Clean split, no duplication.

#### Cluster 9 — session-router.ts (NOT what the name suggests)

`src/session-router.ts:1-238` is **identity routing** across channels (Telegram/WhatsApp/Web → same canonical peer), not provider/turn routing. Don't try to merge into `routing/` or `llm-dispatch`.

#### Cluster 10 — `llm-dispatch.ts` vs canonical adapters

[src/llm-dispatch.ts:75](src/llm-dispatch.ts#L75) `dispatch` is a single-shot text completion helper for memory subsystems. It re-implements provider detection and direct fetches (`:118-123` Anthropic, `:134` OpenAI). Use case (non-streaming, single-shot, fail-silent) genuinely justifies a separate code path, but the *implementation* duplication with `anthropic-client/stream-api.ts` is real — would benefit from a shared `anthropic-http-base.ts`.

### 2.6 Dead code

> Methodology: static import-graph scan (basename → `.js` resolution) cross-checked against dynamic `await import("...")`; `tsc --noEmit --noUnusedLocals` for unused imports/locals. The only dynamic-loader in `src/` is `plugin-system.ts` and it loads from `~/.lax/plugins`, NOT from `src/`. Routes/tools/agents/hooks/protocols are explicit registries, not auto-discovery directories. Filename-based scanning is therefore safe.

#### A. Files with zero call sites

**A1. Confirmed dead — single-line empty stubs (`return []`):**

- [src/bookkeeping-tools.ts](src/bookkeeping-tools.ts), [src/cloud-storage-tools.ts](src/cloud-storage-tools.ts), [src/contacts-tools.ts](src/contacts-tools.ts), [src/crm-tools.ts](src/crm-tools.ts), [src/ecommerce-tools.ts](src/ecommerce-tools.ts), [src/notification-tools.ts](src/notification-tools.ts), [src/payment-tools.ts](src/payment-tools.ts), [src/sms-tools.ts](src/sms-tools.ts) — 8 files, 0 imports each.

**A2. Confirmed dead — never referenced and not on any npm script:**

- [src/anthropic-client/stream-oauth.ts](src/anthropic-client/stream-oauth.ts) — `streamViaOAuthSDK`. 0 imports. OAuth subscription goes through `stream-cli.ts` instead.
- [src/batch-embeddings.ts](src/batch-embeddings.ts) — `BatchEmbeddingManager`, ~260 LOC, 0 imports.
- [src/codex-session.ts](src/codex-session.ts) — `getOrCreateCodexSession`, etc. 0 imports.
- [src/codex-payload-policy.ts](src/codex-payload-policy.ts) — `CodexPayloadPolicy`. 0 imports.
- [src/classifiers/vision-entity-extract.ts](src/classifiers/vision-entity-extract.ts) — 0 imports.
- [src/security-rbac.ts](src/security-rbac.ts) — 0 imports. Live module is `rbac.ts`.
- [src/smart-compaction.ts](src/smart-compaction.ts) — 0 imports. Header claims it replaces conversation-compactor, but neither is wired in.
- [src/tool-interface.ts](src/tool-interface.ts) — duplicate `buildToolPromptSection`. Live one is in `tool-prompt-builder.ts:22`.
- [src/voice-tools.ts](src/voice-tools.ts) — 0 imports.
- [src/voice/voice-llm.ts](src/voice/voice-llm.ts) — 0 imports. Comment claims it bypasses `prepareAgentRequest + runAgent` but nothing calls it.
- [src/workers/dag-templates.ts](src/workers/dag-templates.ts) — 0 imports.

**A3. Suspected dead — imported only by `src/test-suite.ts`:**

`test-suite.ts:103-172` smoke-imports a long list to verify they parse. If `test-suite.ts` is the only consumer, the module is not wired in. `test-suite.ts` itself requires `~/.lax/config.json` and `127.0.0.1:7007` running — likely manual-CLI scaffolding. Each entry is suspected dead, **needs runtime verification**:

`agent-protocol.ts`, `audio-agent.ts`, `audio-cues.ts`, `battery-scheduler.ts`, `benchmark-suite.ts`, `compute-offload.ts`, `conversation-compactor.ts`, `demo-recorder.ts`, `demo-runner.ts`, `driver-abstraction.ts`, `embedded-runtime.ts`, `error-categories.ts`, `headless.ts`, `io-abstraction.ts`, `ipc-channel.ts`, `offline-queue.ts`, `ota-update.ts`, `parallel-tools.ts`, `portable-memory.ts`, `response-cache.ts`, `session-recovery.ts`, `speaker-id.ts`, `stream-reliability.ts`, `tool-sdk.ts`, `tool-timeout.ts`, `tts-stream.ts` (root — distinct from live `src/voice/tts-stream.ts`), `video-summary.ts`, `voice-auth.ts`, `voice-commands.ts`, `voice-fast.ts`, `voice-timeline.ts`, `benchmark-longmemeval.ts`.

**A4. False-positive avoided** (looked dead, actually loaded via `await import`):

`camera-tool.ts`, `conversation-ingest.ts`, `conversation-parsers-sqlite.ts`, `auth-refresh.ts`, `quality-scorer.ts`, `tool-rag.ts`, `tool-arg-repair.ts`, `ollama-cloud.ts`, `memory-hyde.ts`, `memory-mmr.ts`, `memory-reranker.ts`, `memory-resolver.ts`. **Alive.**

#### B. Unreachable conditional branches

`tsc --noEmit --allowUnreachableCode false` produced zero diagnostics. Grep for `if (false)`, `if (true)`, `if (process.env.LEGACY ...)`, `if (process.env.DEPRECATED ...)` — zero hits.

Only `@deprecated` marker in the codebase: [src/memory/manager.ts:38-43](src/memory/manager.ts#L38) — `TurnContext.smartContext` field is `@deprecated Always empty.` Documented dead state still emitted every call.

`LEGACY_*` symbols inside `src/canonical-loop/` are active compatibility bridges, not dead.

#### C. Unused imports / locals

`tsc --noEmit --noUnusedLocals` produced 82 diagnostics. Worst offenders:

- [src/session-export.ts:1-2](src/session-export.ts#L1) — 3 unused imports. (Combined with A3 status, strong dead-file signal.)
- [src/camera-tool.ts:6-7](src/camera-tool.ts#L6) — 2 unused imports.
- [src/document-tools.ts:1,16](src/document-tools.ts#L1) — 2 unused.
- [src/memory-importance.ts:17,220,336](src/memory-importance.ts#L17) — 1 import + 2 locals.
- [src/routes/chat.ts:6,8,129](src/routes/chat.ts#L6) — 4 unused (`isValidSessionId`, `detectInjection`, `delegateMessageToWorker`, `linkDecisionToOpId`).
- [src/agent-codex/run-http.ts:11,83](src/agent-codex/run-http.ts#L11) — `checkActedAndAsked`, `shouldForceTools` declared but never read (suggests detector wiring was reverted but imports stayed).
- [src/providers/run-standard.ts:87](src/providers/run-standard.ts#L87) — `shouldForceTools` same pattern.
- [src/tool-executor.ts:61,68,75](src/tool-executor.ts#L61) — 3 unused type aliases.
- [src/hot-reload.ts:14](src/hot-reload.ts#L14) — `relative` import unused.

All 82 are safe-to-remove (cosmetic). They're signal of incomplete refactors.

#### D. Config flags

**D1. Confirmed orphans:**

- [src/config.ts:88](src/config.ts#L88) — `browserIdleTimeoutMs` (default 600000). Only "read" site is in `db-migrations.ts:38` inside an unused default-object template. **Confirmed dead.**
- [src/config.ts:93](src/config.ts#L93) — `maxAudioBytes` (default 26214400). Only appears in `types.ts:291` declaration. **Confirmed dead.**

**D2. Suspected dead (PROFILE_DEFAULTS):**

- [src/config.ts:17,25,33](src/config.ts#L17) — `sandboxMode` per profile. Typed in `ProfileDefaults` and emitted into every profile but never applied in `loadConfig()` (only `toolApproval`, `retentionDays`, `autoUpdate`, `logLevel` are applied at lines 173-176).
- [src/config.ts:21,29,38](src/config.ts#L21) — `networkExposure` per profile. Same.

Suspected dead, **needs verification** (could be consumed by an external UI reading raw config).

#### E. Old adapter versions / commented-out paths

- No `-old`, `-legacy`, `-v1`, `-deprecated` filenames exist.
- No 5+ line commented-out code blocks found.
- E1: `anthropic-client/stream-oauth.ts`, `codex-session.ts`, `codex-payload-policy.ts` — covered in A2.
- E2: `tool-interface.ts:67` (`buildToolPromptSection`) vs `tool-prompt-builder.ts:22` — duplicate. The latter is canonical.

#### F. Test files referencing deleted code

All `.test.ts` imports resolve. None reference deleted modules.

### 2.7 Stepping-on-each-other patterns

#### Pattern 1 — Two writers for `session.messages` (HIGH severity)

[src/routes/chat.ts:287-433](src/routes/chat.ts#L287). Canonical path writes `op_messages.jsonl` via `appendOpMessage` ([chat-runner.ts:249,261](src/canonical-loop/chat-runner.ts#L249)) then re-synthesizes `session.messages` from disk at [routes/chat.ts:351-360](src/routes/chat.ts#L351). Legacy fallback mutates `session.messages` in place ([agent-loop/run.ts:301](src/agent-loop/run.ts#L301), [run-standard.ts:260](src/providers/run-standard.ts#L260), [run-anthropic.ts:214](src/providers/run-anthropic.ts#L214)).

The snapshot-and-revert at [routes/chat.ts:294,425](src/routes/chat.ts#L294) exists *specifically because* both writers can run for the same turn if canonical throws mid-execution. If canonical throws after writing some `op_messages` but before the synthesis, disk persists state that the in-memory `session.messages` reverted away from. Disk and memory drift for the same conversation.

#### Pattern 2 — Adapters bypassed (CONFIRMED)

`streamAnthropicResponse` called directly (bypassing both adapter towers and both loops) from:

- [memory/curate-classifier.ts:188-189](src/memory/curate-classifier.ts#L188)
- [memory/end-of-turn-write.ts:132-133](src/memory/end-of-turn-write.ts#L132)
- [routing/llm-classifier.ts:80-82](src/routing/llm-classifier.ts#L80)
- [routing/worker-redirect-classifier.ts:118-119](src/routing/worker-redirect-classifier.ts#L118)
- [classifiers/classify-with-llm.ts:173-174](src/classifiers/classify-with-llm.ts#L173)
- [voice/voice-llm.ts:20,75](src/voice/voice-llm.ts#L20) — but `voice-llm.ts` itself is dead per §2.6

Same for `streamCodexResponse`: [agent-codex/run-http-helpers.ts:274](src/agent-codex/run-http-helpers.ts#L274), [memory/curate-classifier.ts:229-230](src/memory/curate-classifier.ts#L229), [memory/end-of-turn-write.ts:148-149](src/memory/end-of-turn-write.ts#L148), [classifiers/classify-with-llm.ts:190-191](src/classifiers/classify-with-llm.ts#L190).

These are partly *justified* (non-tool, non-agent single-shot classifier calls) but they each independently re-implement auth resolution. The clean abstraction `llm-dispatch.ts` exists for exactly this use case — yet only `memory-resolver`, `memory-extract`, `memory-hyde`, and `operations/decomposer` use it. The classifiers and voice path went straight to streamers. If auth resolution changes (e.g., new token type), `llm-dispatch.callAnthropic` catches it; the direct callers don't.

#### Pattern 3 — Stacked retries (CONFIRMED)

A single failing Anthropic 429 can trigger retries at four layers, none of which share a budget or correlation key:

1. Inside Anthropic CLI warm-pool — eviction + retry on stalled subprocesses ([anthropic-client/warm-pool.ts](src/anthropic-client/warm-pool.ts))
2. Inside `tool-executor.ts:614-621` — `withRetry({maxRetries:2, shouldRetry:isTransientError})`. Applies if tool ∈ `RETRYABLE_TOOL` ([:27-33](src/tool-executor.ts#L27)); `http_request`/`web_fetch` are in that set.
3. Inside each loop's stream-error handler — [agent-loop/run.ts:247-255](src/agent-loop/run.ts#L247), [run-standard.ts:216-224](src/providers/run-standard.ts#L216), [run-anthropic.ts:188-196](src/providers/run-anthropic.ts#L188). Catches 429, calls `forceCompact`, `continue`s. The same 429 retried inside the model call lands here again.
4. Inside [routes/chat.ts:525-580](src/routes/chat.ts#L525) — outer cascade. If the whole `runAgent` returns `errKind === "rate-limit"`, retries on a different provider.

Plus the **dormant** layers: `model-fallback.ts:withFallback` and `provider-fallback.ts:ProviderChain`. If anyone wires them up later you get 5th and 6th layers.

`retry-telemetry.ts:logRetry` events fire from each with no `correlationId` to stitch them.

#### Pattern 4 — Auth / token handling (partial collision)

`getAnthropicApiKey()` ([auth-anthropic.ts:113](src/auth-anthropic.ts#L113)) is the single token resolver — good. But **token shape inspection** is reimplemented:

- Shared helper `usesAnthropicSubscriptionAuth` (in `anthropic-models.ts`) — used by [run-anthropic.ts:58](src/providers/run-anthropic.ts#L58), [agent-loop/run.ts:49](src/agent-loop/run.ts#L49), [anthropic-client/stream.ts:21](src/anthropic-client/stream.ts#L21).
- [llm-dispatch.ts:112-114](src/llm-dispatch.ts#L112) — ad-hoc `startsWith("oauth:")` / `startsWith("sk-ant-api")`. Won't pick up new prefixes.

#### Pattern 5 — Logging / telemetry duplicated (MILD)

Every layer logs the same retry event with slightly different fields and no shared correlation key. Same destination file (`~/.lax/telemetry/retries.jsonl`). Reconstructing a chain "429 → context-overflow → compact → fallback codex → tool retry → success" requires manual jq stitching.

#### Pattern 6 — Tool execution forking (CLEAN, no collision)

Confirmed earlier — every path goes through `tool-executor.executeToolCalls`. `parallel-tools.ts:executeParallel` is dead so its drift can't fire. Risk is if anyone resurrects it.

#### Pattern 7 — Two different "stop the runaway turn" mechanisms

- Legacy: `MID_TURN_EVIDENCE_STALE_WINDOW = 3` (`run-anthropic.ts:70`) — file-write count heuristic, aborts the turn.
- Canonical: idle-event watchdog ([turn-loop.ts:101-122](src/canonical-loop/turn-loop.ts#L101)) — wall-clock-based, aborts via `adapter.abort()` after 600s of no adapter reports.

A long-thinking turn emitting stream chunks every 30s but writing no files passes canonical and tripped legacy. A turn writing files every 5s but stuck in an unproductive loop trips legacy but never canonical. Same conceptual concern, incompatible heuristics in two live loops.

#### Pattern 8 — Two parallel feature-flag systems

- `LAX_UNIFIED_LOOP=1` env ([agent.ts:65](src/agent.ts#L65)) — routes through `agent-loop/run.ts`
- `isCanonicalChatEnabled()` + `isCanonicalChatLaneEnabled()` ([routes/chat.ts:279-281](src/routes/chat.ts#L279)) — routes through `canonical-loop/chat-runner.ts`

Canonical wins when both are set (its eligibility check happens first), but the relationship is not enforced anywhere in code.

---

## Phase 3 — Propose the Single Path

### 3.8 Canonical orchestration path (recommendation)

```
Entry  → prepareAgentRequest()                    [unchanged — keep as the request preparer]
       → canonicalLoopEntry(op)                   [the only orchestrator]
       → driveTurn(turn, adapter, dispatcher)     [canonical-loop turn-loop]
            ├ middleware stack (ported from agent-loop/middlewares/)
            ├ provider adapter (T3 only)
            └ tool dispatcher (chat-tool-dispatcher → tool-executor)
```

**Why canonical-loop (loop C) as the orchestrator, not unified-middleware (loop B):**

- C is already the live chat path, has on-disk op state (`operation.json`, `op_messages.jsonl`, `canonical-events.jsonl`, `op-turns/`), supports cancel/replay/reconnect, has the soak-metrics infrastructure, and is what the rebrand consolidation (2026-05-07) targeted. Throwing that out to adopt B would be reverse-progress.
- C has a *behavior gap* — none of the legacy middlewares run on it. B has *clean middleware composition* but doesn't have C's persistence/cancel/replay.
- The natural move: **port B's middleware library into C's `turn-loop.ts`**. B's `src/agent-loop/middlewares/` becomes the middleware library that C consumes. Each middleware wraps adapter calls or post-turn checks. B itself dies along with A.

**Why T3 adapters (canonical-loop adapters) as the only wrapper:**

- T1 (`streamAnthropicResponse`, `streamCodexResponse`, `streamViaAPI`, `streamViaCliWithTools`) is the only real transport — keep it as the low-level wire-format layer.
- T2 (legacy `BaseAdapter` registry) exists only to serve loops A and B. When those die, T2 dies.
- T3 keeps a single, contracted interface (`Adapter.runTurn` / `abort` / `AdapterReport`) — that's the right boundary.
- One exception: T3's `openai-compat.ts:200` currently delegates to T2's `ollamaHttpAdapter`. That call site needs to fold its provider-target resolution + SDK call into T3 directly, so T2 can go away entirely.

**Side channels (Pattern 2):** `streamAnthropicResponse`/`streamCodexResponse` direct callers (classifiers, voice, memory) should route through a single `llm-dispatch`-equivalent helper that owns auth resolution + retry classification + telemetry. The existing `llm-dispatch.ts` is most of the way there; extend it to cover the classifier use cases instead of leaving 6 separate `streamAnthropicResponse` call sites.

### 3.9 Migration plan (ordered, independently shippable)

> Each step preserves runtime behavior on its own; rebuild + run the test suite + smoke-test a chat turn between steps.

**Step 0 — Pre-flight hygiene (zero behavior change).** Files: any. Verify: `tsc --noEmit` clean; full test suite passes; one manual chat turn with each provider.

**Step 1 — Delete confirmed-dead files.** Files: the 8 empty-stub tool files (§2.6.A1), plus `anthropic-client/stream-oauth.ts`, `batch-embeddings.ts`, `codex-session.ts`, `codex-payload-policy.ts`, `classifiers/vision-entity-extract.ts`, `security-rbac.ts`, `smart-compaction.ts`, `tool-interface.ts`, `voice-tools.ts`, `voice/voice-llm.ts`, `workers/dag-templates.ts`. Verify: `tsc --noEmit` clean; full test suite passes. No runtime behavior change expected. **PAUSE for review** before removing the A3 cluster — those require runtime verification that nothing manual-CLI depends on them.

**Step 2 — Delete dead config keys.** Files: `src/config.ts` (drop `browserIdleTimeoutMs`, `maxAudioBytes`). Verify: `tsc --noEmit`; config-load smoke test. Behavior unchanged because they were never read.

**Step 3 — Delete dead retry orchestrators.** Files: gut `src/model-fallback.ts` down to `getProviderHealthStatus` (only used export), delete `withFallback`, `buildFallbackChain`, `recordSuccess/Failure`, `isProviderAvailable`. Delete `provider-fallback.ts:ProviderChain` class (keep `classifyProviderError`). Verify: status routes still serve; chat fallback (the inline `routes/chat.ts:525-580` cascade) still fires across provider failures.

**Step 4 — Delete `parallel-tools.ts`.** Behavior unchanged because `tool-executor` already does parallel batching inline. Verify: `tsc --noEmit`; one chat turn that runs a `readOnly` tool batch (e.g., multi-file read).

**Step 5 — Centralize side-channel direct streamers.** Files: `llm-dispatch.ts` (extend to handle classifier / voice / curate use cases), then refactor `memory/curate-classifier.ts`, `memory/end-of-turn-write.ts`, `routing/llm-classifier.ts`, `routing/worker-redirect-classifier.ts`, `classifiers/classify-with-llm.ts` to call the extended helper. **Voice voice-llm.ts already dead.** Verify: classifier outputs unchanged across a curated test set; memory writes unchanged. **PAUSE for review** — this is a behavior-sensitive cluster.

**Step 6 — Extract `auth/base.ts`.** Files: new `src/auth/base.ts` for PKCE + token-load + token-refresh skeleton; refactor `auth.ts` and `auth-anthropic.ts` to extend it. Behavior unchanged. Verify: login flows for both providers; token refresh fires on schedule.

**Step 7 — Port middleware stack from `agent-loop/middlewares/` into `canonical-loop/`.** Files: new directory `canonical-loop/middlewares/` (or fold into `chat-tool-dispatcher.ts` / wrap around `driveTurn`). One middleware at a time:

1. wall-clock-ceiling
2. token-ceiling
3. heartbeat / onTurnRelease
4. stripEphemeralMessages between iters
5. context-overflow rescue (`forceCompact`)
6. force-tool-use regex
7. loop-detection
8. dead-end nudge
9. post-commit nudge
10. mid-turn-evidence-stale
11. subagent-drain
12. post-turn-detector
13. hallucination-check
14. action-claim-check
15. self-check
16. pause / handoff for "please log in"
17. auto-route build_app

For each: write a unit test that exercises the middleware against a synthetic op trace, port the legacy behavior, wire into canonical-loop. Behavior in *canonical chat* should match legacy behavior in the same scenario. **PAUSE for review** after each — these are user-visible behaviors. Aim for one PR per middleware so any regression bisects to one file.

**Step 8 — Delete legacy fallback in `routes/chat.ts`.** Files: `routes/chat.ts` — drop the `runAgent` fallback path ([:435](src/routes/chat.ts#L435)), drop the snapshot-and-revert dance ([:294,425](src/routes/chat.ts#L294)). Canonical is now the only chat path. Verify: full chat smoke across each provider. **PAUSE for review** — this kills Pattern 1's two-writer collision; if any user flow depended on the fallback for an edge case (e.g., canonical failing on a malformed image), this is where it shows.

**Step 9 — Migrate non-chat orchestration onto canonical.** Files: `server/lifecycle.ts` (voice), `server/background-jobs.ts` (cron, dream, worker-session runner), `autopilot/round-agent.ts`, `agency/handler.ts:runAgentAsync`, `workers/worker-entry.ts:handleAssignOp`. Each currently calls `runAgent` directly; switch each to enqueue a canonical op (lane-tagged) and consume the result. Verify: voice turn smoke; cron mission smoke; autopilot round smoke; sub-agent spawn smoke; worker subprocess op smoke. **PAUSE for review** before each migration — these are independent orchestrators with their own failure modes.

**Step 10 — Delete legacy loops A.** Files: `agent.ts`, `agent-codex.ts` shim, `agent-codex/run-http.ts`, `agent-codex/run-http-helpers.ts`, `agent-codex/run-cli.ts`, `providers/run-standard.ts`, `providers/run-anthropic.ts`, `providers/run-anthropic-helpers.ts`. Verify: `tsc --noEmit`; full test suite; full smoke across providers + tools + voice + cron.

**Step 11 — Delete loop B and T2 adapter registry.** Files: `agent-loop/run.ts`, `agent-loop/middlewares/` (now duplicated by canonical port — keep the canonical copy), `providers/adapter/`, `providers/adapters/*.ts`. **EXCEPT** `providers/adapters/ollama-http.ts` and `providers/adapters/openai-http.ts` — fold their SDK call logic into `canonical-loop/adapters/openai-compat.ts` BEFORE deletion. Verify: chat smoke across each provider; eval suite (`agent-loop/eval/runner.ts` will need to be moved or replaced).

**Step 12 — Fix structural debt that's not part of consolidation.**

- WS chat self-loop ([server/lifecycle.ts:287](src/server/lifecycle.ts#L287)) — replace `fetch /api/chat` with direct `canonical-op` enqueue + subscription. (Marked in-code as known debt.)
- Add `correlationId` to `logRetry` so retry chains stitch (Pattern 5).
- Auto-cleanup for canonical-loop runtime registry on op-terminal events ([runtime.ts:42-43,55-56](src/canonical-loop/runtime.ts#L42)) so callers can't leak per-op state.
- Sub-agent spawn single door — pick `agents/invoke.ts:invokeAgent` and route all spawns through it; remove direct callers of `Handler.spawnAgent` (Pattern §1.1).
- Drop `tool-interface.ts:buildToolPromptSection` if still present; keep only `tool-prompt-builder.ts`.

**Step 13 — Cleanup pass.** Remove 82 unused imports/locals from `tsc --noEmit --noUnusedLocals`. Investigate the A3 "test-suite-only" cluster — if `test-suite.ts` is confirmed dead manual scaffolding, drop the cluster.

### 3.10 Risk register

Things to be cautious about — code that looks dead but might be live, behavior gaps that could silently break, ordering hazards.

#### High-risk

- **R1. `agents/invoke.ts:invokeAgent` is the "intended single canonical door" for sub-agent spawn, but multiple other doors are still live** (`agency/handler.spawnAgent`, `agent_spawn` tool, `delegate` tool). Any sub-agent migration (Step 9) needs to verify which door each caller takes before consolidating.
- **R2. Cancel/replay/reconnect parity.** Canonical has explicit support; legacy `runAgent` does not. After Step 9, ops triggered by cron/autopilot/sub-agents will gain replay-on-reconnect semantics they didn't have before. Could change observable behavior for long-running missions.
- **R3. Voice turn migration (part of Step 9).** Voice uses a special `voice_visual` tool, a different end-of-turn write path (`memory/end-of-turn-write.ts`), and a per-turn STT-finalize trigger. The canonical-loop wasn't designed with voice latency in mind; idle-timeout (600s) and lease semantics need verification.
- **R4. The `usesAnthropicSubscriptionAuth` divergence in `llm-dispatch.ts:112-114`.** Step 5 fixes this implicitly by routing through `getAnthropicApiKey()` + the shared helper, but watch for any caller that *intentionally* wanted the ad-hoc check (e.g., synthetic tokens in tests).
- **R5. `_localNoToolModels` Set state**. Deleting loop B doesn't remove it (T2's `openai-http.ts:54` is what writes it). It dies in Step 11 when T2 dies — but until then, the cross-orchestrator collision persists.
- **R6. Codex 90s silence timer is internal**. Canonical's `adapter.abort()` may not actually cancel a hung codex request; the silence timer fires only if the stream goes truly silent. Worth verifying that abort tests cover Codex.

#### Medium-risk

- **R7. `parallel-tools.ts` is "dead" but `test-suite.ts` imports it.** Step 4's deletion requires removing it from `test-suite.ts` first, or deleting `test-suite.ts` too if A3 is confirmed dead.
- **R8. The A3 cluster.** ~30 files are imported only by `test-suite.ts`. They include `stream-reliability.ts`, `tts-stream.ts` (root), `ipc-channel.ts`, `tool-sdk.ts` — modules that *look* infrastructural. Before deleting, confirm via grep that no CLI script under `scripts/` or any npm script invokes them via `tsx`.
- **R9. `provider-fallback.classifyProviderError` substring vs `model-fallback` status-code semantics.** They classify the same error differently. The inline cascade in `routes/chat.ts` uses `classifyProviderError` already. After Step 3 deletes `withFallback`, no caller uses status-code-keyed classification — but if any code path imports the wrong classifier later, it'll silently misclassify.
- **R10. `tool-policy.ts` vs `tool-policy/` directory split.** Audit found this is clean, but the parallel layout invites future drift. Worth a note in a CLAUDE.md or design doc.
- **R11. Two `previousResponseId` stores for Codex.** Marked as a dead-ghost issue (codex-session.ts has 0 imports). But Step 1 deletes `codex-session.ts` outright — verify no test fixture or ad-hoc tool imports it.
- **R12. `_toolCallSeq` is process-wide.** Two concurrent CLI-path chats share the monotonic counter. Probably fine (IDs only need to be unique per-turn, and they are) but if any caller does cross-turn ID matching, the counter restart on process boot could collide. Needs verification.

#### Low-risk / informational

- **R13. The auto-route build_app middleware only existed in `run-anthropic.ts`.** Standard never had it; canonical doesn't either. Porting it (Step 7.17) restores parity that was probably never working for non-Anthropic providers anyway.
- **R14. The two routing gates before canonical-loop** (`routing/router.routeMessage` + canonical eligibility check). The router decides delegate vs inline; the eligibility check decides canonical vs legacy. If legacy is deleted (Step 10), the second gate becomes a no-op and can be removed.
- **R15. Bridges (WhatsApp/Telegram) already go through canonical.** Easy win; no migration needed in Step 9.
- **R16. The `routes/chat.ts:274` in-code comment** says "runStandardAgent path is dead code post-this commit and slated for removal." This audit confirms it's still reachable as the canonical-failure fallback — the comment is aspirational, not factual yet.
- **R17. `src/orchestrator/`** is the **memory** orchestrator (signal fusion), not an agent orchestrator. Don't confuse with `canonical-loop/` / `agent-loop/` when scoping changes.
- **R18. The MEMORY.md note about `feedback_anthropic_cli_proxy_divergence`** matches what this audit found at `stream-cli.ts:111-143` vs `:173-252` (warm-pool vs cold-spawn duplicate prompt-build). Whichever change Step 5 makes to `serializePriorTurns` needs to land in both blocks until one is deleted.

---

## Coverage Notes

**Fully traced:**
- Chat → canonical-loop → adapter → provider chain.
- Legacy `runAgent` chain for all three provider sub-paths.
- Worker-pool subprocess chain.
- WhatsApp / Telegram bridges.
- Autopilot loop.
- MCP-tool path.
- Voice turn runner.
- Cron-scheduled missions.
- Side-channel direct `fetch` callers.
- Adapter inventories T1/T2/T3 and cross-call sites.
- Shared module-level state and disk writers.
- Confirmed-dead file scan (162 file basenames cross-checked against the full import graph).
- Unused imports / locals via `tsc --noEmit --noUnusedLocals`.
- Config key reachability via `config.<key>` grep + assignment grep.

**Not fully expanded (and what would close the gap):**

- Inner state machine of `canonical-loop/turn-loop.ts` and `canonical-loop/worker.ts` — confirmed they dispatch to the registered adapter; lane/checkpoint/state-machine internals were not line-walked. Closing this requires a read of `canonical-loop/state-machine.ts`, `lease.ts`, `scheduler.ts`.
- `agency/handler.ts`'s full sub-agent lifecycle — confirmed `runAgentAsync` → `runAgent` but plan/decompose/spawn/redirect/kill state machine was not traced.
- `agent-loop/run.ts` Phase-1 middlewares — listed by file name but not each middleware's behavior was line-walked.
- The "A3 cluster" of ~30 test-suite-only files — listed as suspected dead pending runtime verification that nothing manual-CLI invokes them.
- The `app-build`/`primal-auto-build` orchestrator at `server/index.ts:57` (auto-resume) — out of scope for this entry inventory.
- `desktop/`, `python/`, `integrations/`, `eval/` trees — touched only where they appear as entry points.

If you want any of these expanded in a follow-up pass, name the section and I'll spin a focused agent at it.
