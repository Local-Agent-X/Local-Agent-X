# Phase 0 audit — Context handling (brief §2 Q5)

Read-only. Paths relative to repo root, lines 1-indexed. VERIFIED = read the cited lines; INFERRED = derived from structure; UNKNOWN = not established.

## 1. What happens when the window fills

There are **three** compaction surfaces with three different renderings (finding: three owners of "the summary row").

| Lane | Trigger | Keeps | Rendering | Persisted? |
|---|---|---|---|---|
| Chat-lane checkpoint (between messages) | conversation > 35% of window | last 8 rows verbatim; re-cut only after 12 new rows | `role:"system"`, `[Earlier in this conversation]` | yes, `SessionCheckpointRow` |
| Turn-loop compaction (in-op) | 75% compact / 90% critical (Codex 35/55) | 6 / 4 (≥95%) / 2 (≥99% or forced) rows | folded into a **user** row, bracket-labelled | no (recomputed every turn; summary cached per op) |
| Manual `POST /api/compact` | user click | 20 rows | `role:"system"`, `[COMPACTED CONTEXT …]` | yes (rewrites session) |

**Chat lane.** VERIFIED `src/agent-request/prepare-request.ts:94-97` — every user message runs `sanitizeHistory(input.sessionMessages)` then `checkpointedHistory(...)` (or a flat `slice(-maxHistory)` for voice/sub-agents). `src/context-manager/checkpoint-history.ts:72-73`:
```
  const budget = Math.floor(modelWindowTokens * CONVERSATION_BUDGET_SHARE);
  if (budget <= 0 || totalTokens(applied) <= budget) return { messages: applied };
```
Policy values `src/context-manager/compaction-policy.ts:104,108,113` (0.35 / 8 / 12). Summary row `checkpoint-history.ts:43-48` is `role: "system"`.

**Turn loop.** VERIFIED `src/canonical-loop/turn-loop/build-input.ts:28` rebuilds the view from `readOpMessages(op.id)` every turn and calls `compactHistory` (`:90-93`). `src/canonical-loop/turn-loop/compact-history.ts:211-212`:
```
  const status = getContextStatus(toChatParams(messages), model, usageAnchor ?? undefined, resolveAnthropicTransport(), baselineTokens);
  if (!forced && !status.shouldCompact) return { messages, compacted: false };
```
Bands `compaction-policy.ts:45,52` (`{60,75,90}` default, `{25,35,55}` Codex); keep tiers `:66-72`. Split is tool-pairing-safe (`compact-history.ts:84-89`). Summary block `:296-300`, folded into the first kept user row `:314-322` or prepended as `compact-summary-<id>` user row `:324-329`.

**Summarizer.** VERIFIED `src/context-manager/compaction.ts:57-75`: `guardedRewrite` → `classifyWithLLM` (`role:"review"`, 30 s, 6000 chars, `maxAttempts: 2`). Transcript clipped to 30,000 chars, per-row user 2000 / assistant 800 / tool 400 (`:96-99`).

**NOTHING_NOTABLE (H-029).** VERIFIED `compaction.ts:167-170`:
```
  if (/^\s*NOTHING_NOTABLE\s*$/i.test(text) && hasSubstance(messages)) {
```
`hasSubstance` = ≥6 messages and ≥3 rows with a tool marker or >200 chars (`:152-163`). Transcript echo rejected `:143,174-178`. Matches `eval/HARNESS_LEDGER.md:41`.

**Breaker.** VERIFIED `src/canonical-loop/turn-loop/compact-breaker.ts:35-37` — trips after 3 consecutive enabled-nulls, probes every 10th call. `compact-history.ts:217` — a tripped breaker skips the summarizer but never the fit past critical.

**Longest-tail fallback (H-013).** VERIFIED `compact-history.ts:265-277`: null summary + `mustFit` → `largestFittingSplit` (binary search over keep counts, `:152-166`), block text "OMITTED … No summary was available; do not assume…" plus the original request verbatim to 4,000 chars (`:357-371`).

**What is pinned.** System prompt + tool manifest are outside `messages` and never negotiable (VERIFIED `src/context-manager/request-fit.ts:14-20`, `build-input.ts:49-55`). The first user message is **not** pinned: it can be summarized away; the elision path keeps 4,000 chars of it, and the situational digest restates 160 chars from turn 3/4/6 (`situational-awareness.ts:55-71,215-221`). No instruction-ledger text is pinned (see §4).

**Model view.** VERIFIED `src/tool-execution/model-view.ts:18-28`, written by `build-input.ts:99-107` (null when uncompacted); read by read-dedup (`run-sandboxed.ts:100`).

**Recall.** VERIFIED `src/tools/recall-tool.ts:47-53` cursor = `startId:endId`; compaction cites the range (`compact-history.ts:291-295`); output ≤6,000 chars (`:19`). H-022 (`HARNESS_LEDGER.md`) records a model paging history back instead of working — OPEN.

**Overflow routing.** VERIFIED: `src/canonical-loop/adapters/openai-compat/request-preflight.ts:76-80` refuses a too-big request; `openai-compat.ts:168` reports `code: CONTEXT_WINDOW_EXCEEDED_CODE`; `src/canonical-loop/turn-loop/reported-adapter-recovery.ts:21-22`:
```
  const overWindow = error !== null
    && (error.code === CONTEXT_WINDOW_EXCEEDED_CODE || classify(error.message).recovery === "compress");
```
→ `recoverContextOverflow` (`adapter-throw-recovery.ts:54-71`, `OVERFLOW_RETRY_CAP = 2`) → `forceCompactNext` → aggressive keep on the next build. Thrown provider errors take the same path via `src/errors/classifier.ts:103` prose regex. A "floor" window is deliberately **not** refused (`request-preflight.ts:70-75`).

## 2. Token accounting

- Estimate: `chars / 3.5`, +4 per message, +10 per tool call (VERIFIED `src/context-manager/token-estimation.ts:6,11,29`). No tokenizer.
- Anchor: real provider usage + estimate of rows appended since (`token-estimation.ts:56-67`; mapping `compact-history.ts:102-139`; returns null on any unmappable view).
- Baseline (system + tools) added only on the pure-estimate branch (`status.ts:36-38`), suppressed for `provenance === "floor"` and non-`chat_turn` ops (`build-input.ts:81-87`).
- Window: pinned table → probed local → `LOCAL_UNKNOWN_CONTEXT = 8_192` floor → name heuristics → 128k default (VERIFIED `src/context-manager/model-windows.ts:53,63,94-116`). Anthropic subscription lane clamped to 200k (`effective-window.ts:35`); transport defaults to `"cli"` (`resolve-transport.ts:55`).
- Margins: `OUTPUT_RESERVE_TOKENS = 1_024` (`request-fit.ts:40`), `PROMPT_WINDOW_SHARE = 0.35` (`:68`), local completion cap clamped to `window − prompt − 1024` (`openai-compat/local-cap.ts:68-70`).
- **The "num_ctx tiers 65536 / 32768 / constrained-local" do not exist as code.** VERIFIED: a whole-`src` grep for `65536|65_536|32768|32_768` hits only comments and audio code; `constrained-local` is a telemetry `mode` string (`src/context/prompt-degradation.ts:157`). Tiering is by *tool count* (`src/model-tiers.ts:104-110`: weak 8, medium essentials+slots, strong unlimited) and by prompt shedding at 35% of the measured window (`prompt-degradation.ts:120-121`).
- How LAX learns the real window: Ollama `/api/ps` context_length, else `/api/show` `num_ctx`, never the architecture max (VERIFIED `src/local-runtimes/ollama-probe.ts:150-154`); LM Studio/vLLM `max_model_len` / llama.cpp `n_ctx` (`openai-compat-probe.ts:138,240`); re-probed when stale >60 s (`cache.ts:35`).
- What LAX **assumes vs sets**: it never sets `num_ctx` on a chat request — `ollama-probe.ts:22-23` "LAX does not SET num_ctx anywhere yet"; `openai-compat-probe.ts:269-273` `chatExtraBody()` returns `{}`. Background warms/dispatch DO send `options.num_ctx` (`src/local-runtimes/residency.ts:145,266`, `DISPATCH_NUM_CTX = 16_384`) — the 16k↔65k reload thrash in the memory index is structurally confirmed, mitigated by `dispatchNumCtx` (`:170-183`) but only when the chat model is "held". UNKNOWN: whether any chat runtime currently defaults below the prompt size on Peter's box (needs a live `/api/ps`).

## 3. Tool output sizing

Universal budgeter: VERIFIED `src/tool-execution/audit-tool-call.ts:40-54` — **head-only** preview (`content.slice(0, maxSize - 200)` to the last newline), full content spilled to `%TEMP%/lax-results/<sha12>.txt` (`src/tools/result-spill.ts:18-27`), marker names the path and says "grep that file … or read it with offset/limit". Cap = `toolResultCapChars(window, manifestTokens)` clamped to `[4_000, 50_000]` chars (`tool-result-cap.ts:36,42,65-75`); floor-provenance or no-op dispatch → 50,000 (`audit-tool-call.ts:161-167`).

| Tool | Own cap | Shape | Marker | Full copy | Dedup |
|---|---|---|---|---|---|
| bash/shell | 10 MiB capture buffer (`shell-tool.ts:155,206-211`); returns full stdout+stderr (`:277-279`) | head-only via budgeter | budgeter's | spill | no |
| read | none in-tool; <1000 lines forced whole, offset/limit above (`read-write-tools.ts:114-117`); >10k-line warning (`:122-123`) | head via budgeter | `[Lines a-b of N]` | the file itself | yes: "Unchanged since this session last read it" hash-verified stub, only if a real read is still in the model view (`run-sandboxed.ts:96-107`, `read-dedup-evidence.ts:29-46`) |
| grep | `head_limit` 250 lines (`grep-tool.ts:29,261`) | head | buffer-cap WARNING (`:217-218`) | no | 60 s arg-dedup (`dedup-cache.ts:24`) |
| glob | 200 entries, MAX_SCAN 5000, MAX_DEPTH 12 (`glob-tool.ts:77,89,216`) | newest-first head | `truncated` flag | no | same |
| browser `extract` (there is no `get_page_text`/`read_page`; actions are `extract`/`observe`, `browser-tools/index.ts:164,181`) | `MAX_TEXT_LENGTH = 8_000` (`launcher.ts:29`) via `capBody` (`paginate-body.ts:13-19`) | head-only | "[Showing the first N of M chars — pass find:…]" | none (live page) | stateful, never deduped |
| browser `observe` | buttons 20 / links 15 / inputs 15 / selects 10 / checks 10 (`observe.ts:58-62`) | head | counts | no | — |
| browser `evaluate` | 8,000 (`page-ops.ts:219-221`) | head | `[Truncated at …]` | no | — |
| web_fetch | 50,000 + spill (`web-fetch.ts:176-179`) | head | spill note incl. "untrusted" caveat | spill | — |
| http_request | 100,000 + spill (`http-request.ts:264-267`) | head | same | spill | — |
| recall | 6,000 (`recall-tool.ts:19`) | paged | cursor | op store | — |

No tool returns head+tail; no tool reports an omitted **line** count (chars only). CONFIRMED footgun "raw output dumped unbounded": **not present** (everything passes the budgeter), with the caveat that on a floor-provenance window four 50k results (~57k tokens) can still land in one step.

## 4. History growth and durable state

**State block: partial.** VERIFIED `src/canonical-loop/turn-loop/situational-awareness.ts:82-83,120-162`: a code-written, ephemeral trailing user row wrapped `[SITUATIONAL CONTEXT — system-generated, not from the user…]`, carrying pace (turn + tokens), recent actions as `tool✓/✗` (cap 8), **open plan steps from tasks.json** (cap 12 × 100 chars — model-written via task tools, re-injected every turn), and from turn 3/4/6 the goal (160 chars), success criteria and hard constraints from the contextPack. Not carried: discovered facts, open questions, last error. Appended by `build-input.ts:162-181` on interactive/agent/background lanes only.

**Instruction ledger: code-written, never rendered.** VERIFIED `src/canonical-loop/instruction-ledger/ledger.ts:30-37` holds `{prohibitions, obligations, phrases}` per op in a Map; extracted once at turn 0 from the user message by regex gate + LLM confirm (`middlewares/instruction-ledger.ts:45-76`, `extract.ts:1-23`). Its only model-facing surface is a pre-dispatch denial string quoting the phrase (`src/tool-execution/pre-dispatch.ts:230,247`). It is not in the prompt and can hold nothing from tool output.

Nudges are harness rows wearing `role:"user"`, now tagged not dropped (`message-convert.ts:120-129`, `harness-rows.ts:28-40`).

## 5. Thinking blocks

VERIFIED: thinking is streamed as `reasoning_chunk` and never stored — `openai-compat/stream-once.ts:109-121`, `anthropic/stream-consume.ts:81-82`, `codex.ts:155`, `gemini-native.ts:96`. The resend projections read only `text` + `toolCalls` (`openai-compat/canonical-to-chat-param.ts:46-74`, `adapters/canonical-to-transport.ts:88-91`); no adapter constructs a `thinking` block on resend (grep: none). Local `<think>…</think>` is stripped from answer text (`providers/output-sanitize.ts:131-136`). **Exception:** on `finish_reason:"length"` with no answer, the reasoning IS promoted to the assistant text (`stream-once.ts:162-171`) and from then on lives in history. Budget: bounded only by `max_tokens` (`stream-once.ts:54`; local default 16,384 clamped by `local-cap.ts:68-70`); `reasoning_effort` default medium (`reasoning-effort.ts:17`); Ollama classifier calls send `think:false` (`classify-with-llm-dispatch.ts:197`). UNKNOWN whether chat turns to Ollama send `think` at all (no site found).

## 6. Summaries and provenance

- Turn-loop summary is rendered **bare in the user voice** (`compact-history.ts:296-300,314-322`); checkpoint and manual summaries are bare `role:"system"` rows. No untrusted delimiter on any of the three.
- The summarizer prompt (`compaction.ts:8-23`) has **no** "do not follow instructions in the material" line, and it instructs "Preserve every 'do NOT use X'". Its transcript renders tool results as `[user]: [tool result] …` (VERIFIED `compact-history.ts:45` maps `tool_result` → `role:"user"`; `compaction.ts:123-124` labels by `m.role`). A web page saying "do NOT use X" therefore arrives labelled as user speech and can be lifted into CONSTRAINTS, then re-injected as user text. **CONFIRMED (structural), no live incident found.** The 400-char tool clip also usually cuts off the `wrapExternalContent` closing caveat (`sanitize.ts:281-285`).
- The situational digest sources only contextPack, the action ledger and tasks.json — no tool output — but task descriptions are model-written and unbounded in origin.

## 7. Step-scoped contexts

VERIFIED delegated ops (`src/ops/tools/shared.ts:88-113`) get `DELEGATED_WORKER_PROMPT`, a lane toolset, and a fresh `op_messages` seeded solely from the contextPack (`initial-prompt.ts:41-60,167-186`): task, success criteria, constraints, ≤6 recent turns × 400 chars, referenced files ≤3,000 chars each. They inherit no parent history. Voice/sub-agent/inbound callers pass `maxHistory` (`prepare-request.ts:95-96`; `server/inbound-channel-runner.ts:128` = 30 rows). The Anthropic "warm pool" is a CLI-subprocess transport pool, not a context. Fan-out: no `src/` module by that name found — UNKNOWN (memory says design LOCKED, not built).

## 8. Append-only transcript (roadmap Step 1)

CONFIRMED in part. Every chat message still creates a new op seeded from `session.messages` (VERIFIED `routes/chat/run-chat-turn/orchestrator.ts:168-172` → `prepare-request.ts:94-97` → `chat-runner/seed-messages.ts:22-32`). But two clauses of the roadmap text are now stale: the row-count slide is gone (replaced by the persisted checkpoint, `prepare-request.ts:86-92`; `providers/truncate-history.ts` no longer exists though `compaction-policy.ts:14-18`, `compact-summary-cache.ts:14` and `checkpoint-history.ts:4` still cite it), and nudges are kept, tagged (`harness-rows.ts:4-21`). Per-op in-turn compaction is still recomputed every turn from the raw replay (`build-input.ts:39-44`), mitigated by the summary cache (`compact-summary-cache.ts:71-83`).

## Footgun checklist (Appendix C, context items)

| Footgun | Verdict | Evidence |
|---|---|---|
| Raw tool output dumped unbounded | **not present** | budgeter at `audit-tool-call.ts:40-54`, window-aware cap |
| Thinking left in history / budget uncapped | **partial** | not resent (§5) except the `length` promotion `stream-once.ts:162-171`; budget = `max_tokens` only |
| History grows forever, no compaction, no state block | **not present** | two compaction lanes + digest; state block lacks facts/errors (§4) |
| Summarizer copies instruction-shaped tool text into trusted prompt | **confirmed (structural)** | `compact-history.ts:45` + `compaction.ts:13,123` |
| Runtime default context below prompt size | **unknown live; structurally guarded** | preflight refuses measured over-window (`request-preflight.ts:76-80`), sends on floor (`:70-75`); LAX never sets chat `num_ctx` |

## Findings worth a ticket

1. Tool results enter the summarizer as `[user]:` rows with no untrusted framing (§6).
2. `CHAT_DIGEST_BUDGETS` (`compaction-policy.ts:136-156`) has no consumer outside context-manager; its documented owner `providers/truncate-history.ts` is deleted — dead policy plus three stale cross-references.
3. Three summary renderings, three roles/labels (system / user / system) — one summary contract would let the untrusted-delimiter fix land once.
4. The window never flows back to the runtime: LAX measures `num_ctx` but only background warms set it (`residency.ts:266`), so the chat model's window is whatever Ollama last loaded.
5. `tool-result-cap.ts:34-35` says `DEFAULT_MAX_RESULT_SIZE` is "mirrored (not imported)"; `audit-tool-call.ts:20,29` now imports it — stale comment only.
