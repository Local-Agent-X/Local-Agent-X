# Phase 0 audit — Model adapters (brief §2 Q2): what LAX puts on the wire to local runtimes

Read-only. Every claim below is VERIFIED by reading unless marked INFERRED/UNKNOWN. Paths are repo-relative, lines 1-indexed.

## 1. Providers and the two local paths

Provider ids: `src/providers/provider-ids.ts:1-11` (`local` is the only local id; `ollama-cloud` is remote). Local runtimes discovered by `src/local-runtimes/` come in exactly two kinds, and **every** chat request goes to `<root>/v1`:

```
src/local-runtimes/types.ts:19   export type LocalRuntimeKind = "ollama" | "openai-compat";
src/local-runtimes/discovery.ts:66   chatBaseUrl: `${c.endpoint.baseUrl.replace(/\/+$/, "")}/v1`,
src/providers/registry.ts:244   baseURL: (ctx) => `${ctx.ollamaUrl}/v1`,
```

The openai-compat probe claims LM Studio, vLLM, llama.cpp, LocalAI, LiteLLM, Xinference, Lemonade, TGI, llamafile, Docker Model Runner (`src/local-runtimes/openai-compat-probe.ts:2-5,165`). **Ollama native `/api/chat` is never used** (grep: only `/api/generate` callers exist — `src/llm-dispatch/ollama.ts:95`, `src/local-runtimes/residency.ts:255`, `src/memory/reranker.ts:75`).

| Path | Chain | Endpoint |
|---|---|---|
| CHAT (provider `local`) | `chat-runner/register-adapter.ts:128-157` → `resolveOpenAICompatTarget` (`adapters/openai-compat/resolve-target.ts:48-92`, per-model runtime lookup, else `config.ollamaUrl`/v1 at :95-112) → `OpenAICompatAdapter.runTurn` (`adapters/openai-compat.ts:139-160`) → `streamOnce` → `OpenAIHttpAdapter.stream` (`src/providers/adapters/openai-http.ts:177-216`) | `POST {chatBaseUrl}/chat/completions`, streaming, OpenAI SDK 4.104.0 |
| BACKGROUND / classifier | `classify-with-llm.ts:196-224` → `resolveBackgroundModel` (`providers/background-model.ts:50-87`: pinned `localClassifierModel` else the chat model — nothing auto-picked) → `classify-with-llm-dispatch.ts:154-199` → `llm-dispatch.ts:179-201` → `callOllama` (`llm-dispatch/ollama.ts:77-124`) | `POST {ollamaUrl}/api/generate`, non-stream. If the pinned model's certified target is `openai-compat` kind: `callOpenAICompatible` (`llm-dispatch/hosted.ts:162-230`) → `/v1/chat/completions` non-stream |
| Third owner (dormant) | `src/memory/reranker.ts:74-79` — raw `/api/generate`, default model literal `qwen2:7b`, no keep_alive, no num_ctx, 60 s timeout. Reached only via dynamic import in `src/memory/index-search/search.ts:111,124` when `options.rerank` is set; no live setter found (only the type at `index-search/types.ts:16`). | finding: divergent Ollama writer |

Agent sub-runs use the same adapter via `provider-adapter-factory.ts:217-231` (adds `maxTokens`, `requireToolOnFirstTurn`, effort `"low"` on short path); app-build via `app-build-adapter.ts:385-392`.

## 2. Exact request bodies

### 2a. CHAT — `/v1/chat/completions` (`openai-http.ts:177-216`)

| Field | Sent? | Where / value |
|---|---|---|
| model | yes | `:184` `model: req.model` |
| messages | yes | `:185-188` `[{role:"system",content:req.systemPrompt}, ...req.messages]`; history from `openai-compat/canonical-to-chat-param.ts:19-123` (tool results as `role:"tool"`, redirect as `[REDIRECT]` user row) |
| tools | yes unless latched | `:189` `toOpenAITools(req.tools)` → `{type:"function",function:{name,description,parameters}}` (`providers/shared/tool-shape.ts:60-69`); omitted when `hasNoToolSupport(baseURL,model)` (`:134`) |
| tool_choice | turn 0 only | `openai-compat.ts:128-137,155-159` forced tool or `"required"` |
| temperature | yes | `:191` `temperature: req.temperature ?? 0.7`; req value = `opts.temperature ?? 0.7` (`openai-compat.ts:150`) ← `prepared.temperature` (`register-adapter.ts:152`) ← `resolve-provider.ts:221` `saved.temperature ?? config.temperature` ← `src/config-schema.ts:18` `.default(0.7)`. Same value on every turn (tool or prose). |
| max_tokens | yes (local) | `:152-156` `req.maxTokens ?? (local ? LOCAL_DEFAULT_MAX_TOKENS : undefined)`; `providers/adapter/types.ts:28` `= 16384`; clamped by `openai-compat/local-cap.ts:55-71` on a *measured* window: `min(explicit ?? 16384, window − promptEstimate − 1024)`; **if that budget < 256 the cap is omitted entirely** (`:69`). |
| stream | yes | `:195` `stream: true` |
| stream_options.include_usage | **no** for local | `:107-116,196` only for registry cloud baseURLs |
| reasoning_effort | conditional | `:199-201` when `isReasoningCapable` — for local baseURLs the fallback regex `:42` `/deepseek-r1\|qwen.*reasoning\|gpt-oss\|glm-4\.7/i`; value `effortForChatCompletions(req.reasoningEffort ?? "medium")` (`reasoning-effort.ts:17`); mechanical tool-result steps capped to `"low"` (`canonical-loop/step-effort.ts:52,114-122`) |
| response_format | no (chat never sets `responseFormat`) | `:204-215` |
| keep_alive, think, format, options.num_ctx, num_predict, top_p, top_k, min_p, repeat_penalty, stop, seed | **omitted** | grep of all wire bodies (providers/, canonical-loop/adapters, llm-dispatch*, local-runtimes, classifiers) finds none; runtime defaults apply |
| SDK timeout / retries | not set | `openai-http.ts:133` `new OpenAI({ apiKey, baseURL, fetch? })` → SDK defaults `node_modules/openai/core.js:138` `maxRetries = 2, timeout = 600000` |

Self-heal: a 400 naming `tools` / `reasoning_effort` / `temperature` / `response_format` / `max_tokens` drops that one param, retries once, and persists the fact to `~/.lax/model-capabilities.json` keyed `(baseURL, model)` (`openai-http.ts:229-318`; `model-capabilities-store.ts:61-63,116-133`).

### 2b. BACKGROUND — `/api/generate` (`llm-dispatch/ollama.ts:103-107`)

```
model, prompt, stream: false, keep_alive: MODEL_KEEP_ALIVE,
...(think !== undefined ? { think } : {}),
options: { temperature, num_predict: maxTokens, ...(numCtx !== undefined ? { num_ctx: numCtx } : {}) },
```

| Field | Value / source |
|---|---|
| prompt | `${systemPrompt}\n\n---\n\n${userPrompt}` (`classify-with-llm-dispatch.ts:188`) — system prompt is folded into the completion prompt; runtime applies its chat template as one user turn |
| keep_alive | `"30m"` (`residency.ts:32`) |
| think | `false` from classifiers (`classify-with-llm-dispatch.ts:197`); undefined from other dispatch callers |
| options.temperature | 0 default (`llm-dispatch.ts:104`); classifiers pass 0 (`:194`) |
| options.num_predict | 200 default (`llm-dispatch.ts:105`); classifiers `max(400, ceil(maxChars/3))` = 400 at the 800-char default (`classify-with-llm.ts:55,231`) |
| options.num_ctx | `dispatchNumCtx` (`residency.ts:169-183`): loaded → its `/api/ps context_length`; held chat model or `sizeBytes > 6e9` → undefined (runtime default); dispatch-sized & not loaded → `DISPATCH_NUM_CTX = 16_384` (`:145,148`) |
| stop / top_p / top_k / min_p / repeat_penalty / seed / format | omitted |
| timeout | `AbortSignal.timeout(timeoutMs)` (`ollama.ts:108`), 8000 ms classifier default (`classify-with-llm.ts:54`) |

The openai-compat classifier leg (`hosted.ts:188-205`) sends `model, temperature, max_tokens, messages:[{role:"user"}]` (+ optional `response_format`), no `stream`, no `think`, no keep_alive.

**Where 16384 / 65536 / 32768 / "constrained-local" come from.** 16384 = `residency.ts:145` (and, unrelated, `LOCAL_DEFAULT_MAX_TOKENS` output cap `adapter/types.ts:28`). **65536 does not appear in `src/`**: it is the runtime's own loaded context, read back from `/api/ps` (`ollama-probe.ts:92-104`, `residency.ts:127-128`) and it is what a `/v1` request loads because LAX sends no `num_ctx` there — `ollama-probe.ts:16-23` documents that `/v1` silently drops `num_ctx` (verified live 2026-07-17) and `chatExtraBody()` returns `{}` (`:177-179`; no consumer of `chatExtraBody` exists anywhere — dead seam). 32768 appears only in a comment (`request-fit.ts:48`). "constrained-local" is a *prompt-degradation mode*, not a context size (`src/context/prompt-degradation.ts:157`, budget = `floor(window × 0.35)` at `:121`, `PROMPT_WINDOW_SHARE` `request-fit.ts:68`). Nobody decides num_ctx for chat; `dispatchNumCtx` decides it for background calls. The memory note `local-model-num-ctx-thrash.md` records the 2026-09-15 reload storm and marks the num_ctx half FIXED by the `loaded → reuse` rule.

### 2c. Certification and probe bodies

Certification (`certification-scenarios.ts:53-54`) `{ model, messages, temperature: 0, max_tokens: 256 }` per scenario, POSTed to `${base}/v1/chat/completions` (`certification-transport.ts:30`). Tool probe (`tool-capability-probe.ts:114-122`) `max_tokens: 256, temperature: 0, stream: false, tools:[ping], tool_choice: auto → required`.

## 3. Stop sequences and max tokens per turn type

No local request carries `stop` (grep). One output cap for every chat turn type: `openai-compat.ts:151,179-186` sets `req.maxTokens` identically for tool-call, report and content turns; only callers like voice/agents pass an explicit cap (`providers/types.ts:35-39`, `provider-adapter-factory.ts:224`). Classifiers: `num_predict` 400. No per-turn-type cap exists.

## 4. Keep-alive and pre-warm

- `keep_alive:"30m"` is sent **only** on `/api/generate` (dispatch `ollama.ts:104`, warm `residency.ts:265`). Chat sends none; `residency.ts:200-205` states `/v1` ignores it (verified live 2026-08-25).
- Chat residency: `holdChatModelResidency` (`residency.ts:222-231`) fires at the first chat-turn target resolve (`resolve-target.ts:76-79,105-109`), warms via `/api/generate` with `prompt:""` and **no num_ctx** (`:258-266`) and re-ups every `CHAT_RESIDENCY_REUP_MS = 4 * 60_000` (`:207`). Ollama-native only: "OpenAI-compat runtimes (LM Studio, vLLM) manage their own TTLs" (`:219-220`).
- No boot-time chat warm: `server/bootstrap-services.ts:80-141` only pulls/verifies the *embedding* model. No prompt-prefix pre-warm anywhere (warm prompt is empty).
- Classifier cold-skip: budget < 20 s and model not resident → skip + fire warm at the dispatch num_ctx (`classify-with-llm-dispatch.ts:36,168-183`).

## 5. Thinking

Chat: no `think` field; only `reasoning_effort` for regex-matched families (§2a). Classifier `/api/generate`: `think:false` (H-016; `classify-with-llm-dispatch.ts:197` → `llm-dispatch.ts:185,194` → `ollama.ts:105`); **not** forwarded on the openai-compat classifier leg (`llm-dispatch.ts:197-200` drops it). History: the finalized assistant row carries only `assembledText` + `toolCalls` (`openai-compat.ts:246-256`), so streamed `reasoning`/`reasoning_content` is stripped — except the length-stop fallback promotes thinking into the answer text (`stream-once.ts:162-171`), after which it *is* history. Budget: none; `stream-once.ts:54` "thinking is bounded by max_tokens regardless". The local rider asks reasoning families to "deliberate briefly" in prose (`provider-riders.ts:98-99,116`).

## 6. Sampling and retries

Chat 0.7 (settings-overridable) for every turn; classifier/certification/probe/reranker 0. Retries never change temperature or seed:
- `withTransportRetry` (`adapters/transport-retry.ts:40-45,103-155`): ≤3 attempts, transient categories only (`resilience-policy.ts:29-34`), identical body, backoff `:193-198`. The SDK's own 2 retries sit underneath (`core.js:138`) — worst case 9 sends of one prompt.
- Empty-with-tools retry (`openai-compat.ts:208-222`): same body minus `tools`; on loopback it **permanently** latches `noTools` to disk (`:216-218`).
- Overflow: `recoverContextOverflow` → `forceCompactNext`, cap 2 (`turn-loop/adapter-throw-recovery.ts:32,54-61`).

## 7. Preflight and what follows

`request-preflight.ts:48-82`: window from `resolveContextWindow` (`model-windows.ts:94-116`: pinned table → probed local → `LOCAL_UNKNOWN_CONTEXT = 8_192` floor `:63` → name heuristic), fit from `assessRequestFit` (`request-fit.ts:106-127`, budget = window − `OUTPUT_RESERVE_TOKENS 1_024`). Refuses only on a measured window: `:70-75` "the 8,192-token floor is a placeholder … so preflight is not refusing this send". Refusal reports `CONTEXT_WINDOW_EXCEEDED_CODE = "context_window_exceeded"` (`adapter-contract.ts:149`; `openai-compat.ts:167-173`, `retryable:false`). Caller: `turn-loop/reported-adapter-recovery.ts:21-26` → forced compaction, twice, then the op fails with the `describeUnfittableRequest` text (`request-fit.ts:135-144`). Window unknown at sweep time is re-probed once at target resolve (`resolve-target.ts:86`, `cache.ts:189-229`).

## 8. Timeouts

| Layer | Value | Fires |
|---|---|---|
| Chat per-request | none from LAX; SDK default 600 000 ms | SDK abort → `error` event |
| Idle watchdog | 600 000 ms, reset on every adapter report incl. `reasoning_chunk` (`turn-loop/idle-watchdog.ts:8-12,53`; `stream-once.ts:115-121`) | orchestrator aborts adapter, op error |
| Chat wall clock | 7 200 000 ms `LAX_CHAT_WALLCLOCK_MS` (`chat-runner/create-op.ts:15`); agent runs 15 min (`agent-runner/types.ts:65`) | op ends |
| Classifier | 8 000 ms `Promise.race` wallclock (`classify-with-llm.ts:54,249-284`) + fetch abort; breaker 3 fails → 60 s pause (`:144-145`) | null → heuristic fallback; GPU work continues (H-019) |
| Certification | 30 s/call, 150 s/run, 5 calls (`certification-runner.ts:21-23`) | scenario `timeout` |
| Stream guard | local only, repetition/garble → early stop, turn ends "done" (`stream-guards.ts`, `stream-once.ts:80-105`) | user sees `stopped` notice |

## 9. Chat template and tool-format decision

LAX never overrides the template: no `template`, `raw`, Modelfile write or `chat_template` anywhere (grep; only comments). Native `tools` are sent to every local model unless `(baseURL, model)` is latched `noTools` (`openai-http.ts:134`); the latch is learned from a 400 (`:248-258`), from an empty-with-tools turn on loopback (`openai-compat.ts:216-218`), or up front from `/api/show` capabilities — but that probe runs only on the *agent* path (`agent-runner/register-adapter.ts:60-61`), not chat. Text-tag extraction is a **post-hoc fallback on every turn**, not a per-model mode: `openai-compat.ts:196-198` + `shouldRescueTextToolCalls` (`:97-104`, disabled only for xAI/Gemini hosts); vocabulary `adapters/tool-call-text-tags.ts:21-38`. Decision record: `~/.lax/model-capabilities.json` `{noTools, unsupportedParams, toolsVerified}` (`model-capabilities-store.ts:42-52,80-82`); advisory `toolsVerified` (`tool-capability-probe.ts`) never strips tools. `LocalModelCapabilityProfile.tools.advertised` (`cache.ts:149-169`) only feeds prompt degradation telemetry (`prompt-degradation.ts:57,76,159`).

## 10. Token counting and usage

Estimate = `Math.ceil(text.length / 3.5)` (`context-manager/token-estimation.ts:6`), +4/message, +10/tool call, +8/tool (`request-fit.ts:72`). Chat reads `chunk.usage` when present (`openai-http.ts:341-344`) but does not request it from local (§2a) — whether Ollama/LM Studio emit usage unsolicited on `/v1` streams is **UNKNOWN** (runtime probe settles it). When present it lands in `providerPayload.usageInputTokens/usageOutputTokens` (`openai-compat.ts:274-275`) → `op_turns` → `aggregateOpUsage` (`op-usage.ts:47-52`) → `turn_committed` (`checkpoint.ts:262-266`). `/api/generate` responses carry `prompt_eval_count/eval_count` but `callOllama` reads only `.response` (`ollama.ts:115-116`) — discarded, never logged.

## 11. Certification

"Certified local target" = a process-local publication that `(runtime, model)` passed all five scenarios (`certification-types.ts:3-9`: baseline marker, strict json_schema, forced tool call, tool-result continuation, ~4k-token context marker) with a reusable fingerprint (`runner.ts:115-119`; reusable needs `runtimeVersion` + `modelDigest`, `fingerprint.ts:75`). Persisted in `LocalCertificationStore` by fingerprint, restored after each discovery sweep (`cache.ts:71-86,103`). Triggered **only** by the operator route (`routes/settings/providers.ts:336-338`). Routing effect: it only decides whether a *pinned classifier model* dispatches to its exact runtime (`background-model.ts:76-80`; `llm-dispatch.ts:189-191`); chat routing never consults it (`resolve-target.ts:48-92`). `pickCertifiedLocalClassifierTarget` has no caller outside `local-runtimes/` (H-030 removed auto-selection).

## 12. Footgun checklist (harness side)

| Footgun | Verdict | Evidence |
|---|---|---|
| Runtime default ctx far below prompt | CONFIRMED for the unloaded case, by design | chat sends no `num_ctx`; floor window sends anyway (`request-preflight.ts:70-75`); measured windows are refused/compacted |
| Context length varied between requests | CONFIRMED, bounded | a <6 GB model warmed at 16 384 by a classifier then chatted on `/v1` reloads at the runtime default (`residency.ts:164,179-182` — hold only exists after the first chat resolve) |
| Context raised until GPU→CPU spill | UNKNOWN; no detector | `/api/ps` parse reads only `name/model/context_length` (`residency.ts:123`); `size_vram` never read |
| Repeat penalty > 1.0 | NOT SENT; runtime default applies (Ollama documents 1.1 — runtime auditor to confirm) | §2 tables |
| Chat-default temperature on tool steps | CONFIRMED | 0.7 every turn (`openai-compat.ts:150`, `config-schema.ts:18`) |
| Model unloaded between turns | MITIGATED for Ollama (4-min re-up); CONFIRMED for LM Studio/vLLM/llama.cpp | `residency.ts:207,219-220`; `resolve-target.ts:71-79` |
| No max_tokens on tool-call turns | NOT PRESENT normally (16 384) — **CONFIRMED edge**: cap omitted when window budget < 256 (`local-cap.ts:69`) | |
| Thinking budget uncapped | CONFIRMED | only `max_tokens` bounds it (`stream-once.ts:54`) |
| Identical-prompt retries at temp 0 | CONFIRMED | transport retry resends byte-identical body; classifier legs run at 0 with no seed |
| Quant too aggressive | UNKNOWN; not recorded | LM Studio `quantization` and Ollama `details.quantization_level` are never parsed (`openai-compat-probe.ts:125-141`, `ollama-probe.ts:139-158`) |

## 13. Two-owner / drift findings

1. Three writers of the Ollama-native wire: `llm-dispatch/ollama.ts`, `residency.ts` (warm), `memory/reranker.ts` (no keep_alive/num_ctx, hardcoded `qwen2:7b`).
2. Default temperature literal 0.7 lives in `config-schema.ts:18`, `openai-compat.ts:150`, `openai-http.ts:191`.
3. Reasoning-family regex duplicated verbatim: `registry.ts:116` and `openai-http.ts:42`.
4. `LocalRuntimeProbe.chatExtraBody` (`types.ts:115`) is implemented twice and consumed nowhere.
5. `MODEL_FALLBACKS.local = "llama3:8b"` (`classify-with-llm.ts:119-120`) is a stale literal; the live pick is `resolveOllamaDispatchModel` (`ollama.ts:38-57`, smallest installed) or the chat model.
6. `probeOllamaCapabilities` (`/api/show` noTools) runs for agents only, so chat still pays the empty-turn latch on day one.
