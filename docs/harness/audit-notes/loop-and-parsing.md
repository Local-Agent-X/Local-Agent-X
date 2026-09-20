# Phase 0 audit — agent loop and tool-call parsing (brief §2 Q1, Q6)

Read-only. Every claim below was VERIFIED by reading the cited lines unless marked INFERRED or UNKNOWN. Paths are relative to the repo root; lines are 1-indexed.

## 1. Agent loop — `src/canonical-loop/` is the canonical loop (confirmed)

`src/agent-loop/` holds only `inject-queue.ts` (the mid-turn inject queue); the plan/act/observe cycle lives in `src/canonical-loop/`. The chain, per hop:

| Hop | Where | Load-bearing line |
|---|---|---|
| Op entry (chat) | `src/canonical-loop/chat-runner.ts:88` | `canonicalLoopEntry(op, { sessionId: ctx.sessionId });` |
| Submit | `src/canonical-loop/index.ts:309`, `:352-353` | `export function canonicalLoopEntry(` … `enqueueOp(op.id, op.lane as CanonicalLane);` / `pumpScheduler();` |
| Per-op worker loop | `src/canonical-loop/worker.ts:146`, `:184`, `:243` | `for (;;) {` … `const r = await driveTurn(op, adapter, turnIdx, {` … `if (r.terminalReason !== null) {` (break) |
| Turn cap | `worker.ts:53`; `chat-runner/create-op.ts:60` | `const DEFAULT_MAX_TURNS = 64;` / `budget: { maxIterations: ctx.prepared.maxIterations \|\| 30, maxWallTimeMs: wallClockMs },` — at the cap `evaluateCheckpointStop` decides (worker.ts:160-176), not a hard stop |
| Per-turn function | `src/canonical-loop/turn-loop.ts:60` | `export async function driveTurn(` |

Order inside one `driveTurn` (turn-loop.ts): drain injects `:102` → `beforeTurn` middlewares `:113` → **build request** `:125 const input = await buildTurnInput(op, turnIdx, pendingRedirect);` → **provider call** `:165 result = await adapter.runTurn(input, (r: AdapterReport) => {` (parsing happens inside the adapter; tool calls arrive as `tool_call_requested` reports `:195-197`) → `afterModelCall` middlewares `:264` → **execute tools** `:272 : await dispatchTools(op.id, turnIdx, toolCalls, opts.isCancelled);` → `afterToolExecution` `:289` → **done gate** `:310 … await decideTurnOutcome({` → **append/commit** `:342 commitTurn({`. Next turn re-reads history from disk: `turn-loop/build-input.ts:28 const history = readOpMessages(op.id);` and tools from the per-op registry `:117 tools: getToolsForOp(op.id),`.

**Policy/kernel hop** sits inside tool execution, per call, after the model call: `turn-loop/dispatch-tools.ts:106 const dispatcher = getToolDispatcher(opId);` → `chat-tool-dispatcher.ts:101 … => executeToolCalls(` → `tool-execution/execute-tool.ts:89 const policy = await enforcePolicyPhase(ctx);` → `tool-execution/enforce-policy.ts:329 let outcome = await ariKernelGate(ctx);` … `:345 outcome = lookupTool(ctx);` … `:347 return validateArgs(ctx);` → `execute-tool.ts:110` approval → `:113 await runSandboxedPhase(ctx);`. Note the kernel/egress gates run BEFORE tool lookup and arg validation, so a hallucinated tool name is judged by policy first.

## 2. How a turn ends — `turn-loop/decide-outcome.ts` owns the decision

Main gate (`decide-outcome.ts:220-228`):
```
    (modelSignaledDone || silentTerminates || noTools || mutationTerminates) &&
    assistantText.trim().length > 0
  ) {
    terminalReason = "done";
```
| Heuristic | Definition | Source |
|---|---|---|
| `modelSignaledDone` | provider finish reason ∈ {`end_turn`,`stop`,`stop_sequence`} | `adapters/model-stop.ts:30-33`; threaded at `turn-loop.ts:324 modelSignaledDone: result.modelStop === "ended",` |
| `modelWantsToContinue` | anything else, incl. `tool_calls` AND `length`/`max_tokens` (`model-stop.ts:35-38`) | `decide-outcome.ts:74` |
| `allSilent` | every call in `silent-tool-check.ts:19-45` (voice_visual, memory writes, browser navigate/click/type/scroll…) | `decide-outcome.ts:178` |
| `noTools` | `toolCalls.length === 0` | `:180` |
| `mutationTerminates` | committed write/edit AND no continue signal: `:201 const mutationTerminates = mutationCommitted && !modelWantsToContinue;` | `:184`, `:201` |
| announced-only nudge | interactive lane, no tool ever dispatched, ≤90-char single sentence promising action or a bare command line; one per op | `empty-turn-termination.ts:57`, `:59-60 ANNOUNCED_ONLY_NUDGE = "Your last turn described a command or an intention but made no tool call, so nothing ran. …"`, `:116-129` |
| reasoning-only nudge (H-024) | reasoning, no text, no call → one nudge; 2nd consecutive → honest terminal | `:35 const REASONING_ONLY_LIMIT = 2;`, `:36-37`, `:188-201` |
| empty-turn terminator | fully empty → re-drive once, then `"done"` with "I wasn't able to produce a response…" | `:207 if (modelSignaledDone \|\| emptyState.consecutive >= 2) {`, `:231-233` |
| ask_user terminator | a successful `ask_user` call ends the turn even with empty text | `decide-outcome.ts:257-265`; `ask-user-terminal.ts:26 export const ASK_USER_TOOL = "ask_user";` |
| tool-failure nudge | non-ok tools + no mutation → user-role nudge at turn+1 | `decide-outcome.ts:275-277` |
| continuation guard / gate chain | may re-open "done"; gate order render-verify → build-verify → spec-probe → spec-audit → regression-audit → design-verify → unresolved-tool-intent → earned-done → late-inject → framework-serve | `:291-294`, `:303`; `decide-outcome-gates.ts:241-260` |
| premature-completion (worker lanes only) | final-sounding text + zero calls → one more turn | `middlewares/premature-completion.ts:1-5` |

**Explicit turn type?** None. There is no "done"/"plan" signal the model can emit; "ask the user" exists only as the `ask_user` TOOL. Completion is inferred from finish_reason + prose + absence of calls. Four separate "it didn't act" detectors exist (announced-only, reasoning-only, premature-completion, unresolved-tool-intent) — one concern, four owners; a finding for the consolidation list.

**Finding (VERIFIED by reading, not observed live):** `modelSignaledDone` + non-empty text ends the turn in one pass even when tools were dispatched — `decide-outcome.ts:153-154`: `// a result the model was waiting on. The tool still dispatched and committed` / `// this turn (dispatch is independent of this decision); we just don't loop.` On the openai-compat path a TEXT-TAG call arrives with `finish_reason: "stop"` (the model never used native `tool_calls`), so `modelStop === "ended"`. If any prose survives extraction ("Let me read it. `<tool_call>…`"), `assistantText` is non-empty, the turn is `"done"`, the tool runs, and the model never sees the observation. Only a tag-only reply (empty `remainingText`) loops. This is the local-model instance of the "foreign envelope" footgun: validity up, the loop silently truncated.

## 3. What stops generation after a tool call

- **Stop sequences: none.** `grep -rnE "stop_sequences|stopSequences|\bstop:\s*\["` over `src/providers src/canonical-loop/adapters src/anthropic-client src/local-runtimes` hits only `adapters/model-stop.ts:31 case "stop":`. LAX relies entirely on the provider's finish reason: `providers/adapters/openai-http.ts:337 if (choice?.finish_reason) stopReason = choice.finish_reason;`.
- **(a) Native `tool_calls`:** the runtime ends the message itself; args accumulate per index and are yielded only after the stream closes (`openai-http.ts:362-371`, `:377-381`), then `stream-once.ts:126 … args: parseArgs(ev.arguments) }`.
- **(b) Text-tag calls:** extraction is post-hoc, after the whole stream: `openai-compat.ts:196-197 if (!result.stoppedByGuard && shouldRescueTextToolCalls(baseURL)) { applyToolCallTextFallback(result, report, model, toolNameSet);`, gated on `stream-once.ts:198 if (result.pendingToolCalls.length > 0 || result.assembledText.length === 0) return;` and never for `api.x.ai` / Gemini (`openai-compat.ts:95`). So the model CAN keep writing after a tag — the only mid-stream cuts are a user inject (`stream-once.ts:72-75`) and the local degenerate-output guard (`stream-guards.ts:59-62`, 512-char cadence, 3× repeat of ≥80 chars). The hard ceiling is `providers/adapter/types.ts:28 export const LOCAL_DEFAULT_MAX_TOKENS = 16384;`.
- **Text after the last tag:** kept. `tool-call-text-extractor.ts:134-137` excises only promoted ranges and returns `remainingText`; `stream-once.ts:206 result.assembledText = extracted.remainingText;` → persisted as the assistant text (`openai-compat.ts:248`), shown to the user via `stream_redact` (`stream-once.ts:212`; `chat-runner/event-pump.ts:122-123`), scrubbed of leftover syntax at delivery (`providers/output-sanitize.ts:153`, `routes/chat/run-chat-turn/event-wiring.ts:142-146`), and re-sent next turn (`openai-compat/canonical-to-chat-param.ts:55`).
- **Fabricated-observation detection: NOT PRESENT.** `grep -rni "fabricat|hallucinated.*result|phantom.*result"` finds nothing on this seam. The nearest thing: `<tool_result>` tags are recognized as leak syntax and never promoted (`tool-call-text-tags.ts:34 export const RESULT_TAGS … = ["tool_result"];`, `scanners.ts:179`, `:186`) — but a prose "Result: the file contains…" is invisible.

## 4. Tool-call parsing

**Accepted formats** — native `tool_calls` (above); text vocabulary from `adapters/tool-call-text-tags.ts`: wrappers `tool_call, function_call, function_calls, tool_calls, tool_use, execute_tool, tool_result` (`:21-29`; Hermes `<tool_call>` is this set), named tags `function`, `invoke` (`:38`), `parameter` pairs (`:41`), brackets `[TOOL_CALL]…[/TOOL_CALL]`, `[TOOL_REQUEST]…[END_TOOL_REQUEST]` (`:48-51`), `[tool:NAME]{json}` / exact `[NAME]{json}` (`:54`, `syntaxes.ts:15-17`), channel leaks `<|channel|>… to=NAME <|message|>{json}` (`syntaxes.ts:18`), any tag with a namespace prefix (`tags.ts:57`). Fences are stripped first (`extractor.ts:97`); naked JSON promotes only the exact-name `{"name","arguments"}` envelope or browser shorthand (`extractor.ts:146`, `:166`). Prose is never promoted (`extractor.ts:28-32`).

**Single recognizer? Partly.** The tag vocabulary and scanners are single-owner. But **two promoting parsers exist**: `adapters/tool-call-text-extractor.ts` (openai-compat) and `src/anthropic-client/parse.ts:20 export function parseToolCalls(` with its own envelope regexes (`:26 const fencedRe = …"tool_calls"…`, `:41 const rawRe = …`) plus Anthropic-native `{"name","input"}`, consumed on the Claude-CLI path at `anthropic-client/stream-cli/stream-parse.ts:202` and `:235`. Finding.

**Repair — three ladders, two admitted owners** (`openai-compat/helpers.ts:30-33`: `// Two ladders, one seam family; unification is a parked follow-up.`):
| Ladder | Repairs | Bound | Used by |
|---|---|---|---|
| `repairJsonText` (`tool-call-text-repair.ts:145-186`) | trailing commas, raw control chars (cosmetic); close quote + brackets (structural) | `:180 if (open.length > 50) return null;`; structural output is NEVER executed (`interpret.ts:71-72`, `helpers.ts:40`) | text extraction, `parseArgs` in adapter |
| `repairJson` (`tool-execution/arg-repair.ts:24`) | fence strip, trim-to-braces, trailing commas, single→double quotes, bare keys, Python literals (`:37-99`) | no structural close; more invasive (slices to braces) | `tool-execution/resolve-tool.ts:164-168` |
| `repairMarkerKeys` + `coerceArgs` (`arg-repair.ts:183`, `:198`) | template-marker keys → schema property; scalar/array coercion | one key per property | `arg-validation.ts:85-97` |
Caps: `MAX_TOOL_NAME_CHARS = 120`, `MAX_ARGS_CHARS = 256 * 1024` (`repair.ts:18`, `:25`); name fuzz ≤2 edits and ≤30% (`:216`). Logged via `logRetry({ kind: "tool-arg-invalid" …` phases `json-repair`/`marker-key`/`coerce` (`resolve-tool.ts:168`, `arg-validation.ts:91`, `:96`) and `stream-once.ts:201`.

**What the model sees.** Unknown tool → one line listing exact names (`arg-validation.ts:23-31`). Schema failure → `:105 content: \`Invalid arguments for ${tc.name}: ${errs.join("; ")}. Fix and retry.\`` — one line, no stack. Unparseable args become `{ _raw }` (`resolve-tool.ts:170`), which `validateArgs` skips (`:83`) and then reports as `missing required field "…"` (`:61-63`) — the model is told a field is missing, not that its JSON was malformed. Retries: no parse-specific counter; the error rides back as a tool result and continues under the shared nudge budget (`nudge-budget.ts:28-33`: chat_turn 4, app_build 16, default 8) and maxTurns. Unpromoted syntax left in a "done" reply: first fire → `nudge-ids.ts:22-25 "<wire-format-error: your previous reply contained a tool call written as text. It was NOT executed and produced no result. Reissue it now as a real structured tool call, not as text.>"`, second fire → honest terminal (`tool-intent-gate.ts:108-119`). Nudges are `role: "user"` (`nudges.ts:61`), not fake tool results. Caveat: history rebuild rewrites the ASSISTANT's leaked block to `parse.ts:236 <wire-format-error: prior attempt to call ${toolName} emitted as text — not delivered. …>`.

## 5. Streaming

The OpenAI SDK parses SSE (`openai-http.ts:315-318`); LAX reads `delta.content`, `delta.reasoning ?? delta.reasoning_content` (`:352-360` → `thinking` → `reasoning_chunk`, bus-only, never persisted: `turn-loop.ts:168-176`), and `delta.tool_calls` fragments — parsed only after `done`, so partial JSON cannot break it (VERIFIED). A stray character in args falls into the ladders or `{_raw}`. An SDK-level frame error throws → `:371-374` yields `error` → the turn errors (retried only if nothing streamed yet). UNKNOWN: whether inline `<think>…</think>` in `content` is split out before the done gate (would settle by reading `output-sanitize.ts` for "think"). **H-024** (commit e7dcbb84): reasoning had been surfaced as the answer on ANY stop; now only `stream-once.ts:163 out.providerStop === "length"` — otherwise a reasoning-only turn gets `REASONING_ONLY_NUDGE` once.

## 6. Parallel tool calls

No prompt asks for parallel calls (grep across `agent-request/agents/cognition/ops/protocols` prompt builders: nothing). `parallel_tool_calls` is sent only on Codex Responses (`codex-client/request.ts:106 body.parallel_tool_calls = true;`); openai-compat leaves it to the runtime default. Native multi-call arrays are accepted; execution runs adjacent `readOnly || concurrencySafe` tools in `Promise.all` batches (`execute-tool.ts:184-187`, `:254-266`) capped by `heap-guard.ts:37 export const DEFAULT_MAX_PARALLEL_TOOL_BATCH = 8;`. **No per-tier cap on calls per turn**; the tier cap is on tools OFFERED: `model-tiers.ts:106 case "weak":   return 8;`.

## 7. Retries

| Layer | Trigger | Bound | Prompt/temperature |
|---|---|---|---|
| `adapters/transport-retry.ts:103` | 429/5xx/network, only before any content (`:123 !emittedContent && attempt < maxAttempts`) | `:45 const MAX_TRANSPORT_ATTEMPTS = 3;`; backoff `resilience-policy.ts:194-197` 1s·2^(n-1)+jitter, cap 8s/16s | identical `req` re-issued (`stream-once.ts:62`); temperature = configured, `openai-compat.ts:150 temperature: this.opts.temperature ?? 0.7,`, default `config-schema.ts:18 …default(0.7)` |
| `turn-loop/adapter-throw-recovery.ts:73` | thrown adapter error | `:25 const ADAPTER_ERROR_CAP = 2;`; overflow `:32 … = 2` → compaction | NOT identical: a user-role resume nudge is appended (`:90-94`) |
| `worker-adapter-retry.ts:10` | reported retryable error with zero activity (`reported-adapter-recovery.ts:28-29`) | `decideRecovery` in `ops/heartbeat.ts` — bound UNKNOWN (not read) | re-queued, possibly failed over to another runtime |
| `openai-compat.ts:208-222` | empty text + empty calls with tools attached | once, without tools; loopback → `:218 if (latch) markNoToolSupport(baseURL, model);` PERMANENT for the process | same prompt minus tools |
No path resamples at a different temperature; nothing runs at 0 unless the user configured it.

## Footgun verdicts

| Footgun | Verdict | Evidence |
|---|---|---|
| No stop condition after a tool call | CONFIRMED on the text-tag path (no stop sequences; post-hoc extraction; tail text kept; observation never returned when prose + `stop`); NOT PRESENT for native calls | §3, §2 finding |
| Streaming parser chokes on partial JSON / stray char | NOT PRESENT (args parsed after `done`; structural repairs refused) | `openai-http.ts:377-381`, `helpers.ts:40` |
| Model asked for parallel calls it can't make | NOT PRESENT (nothing asks; flag not sent on openai-compat) | §6 |
| Errors as stack traces | NOT PRESENT for validation/unknown-tool (one-liners). Transport messages are interpolated verbatim into the resume nudge (`adapter-throw-recovery.ts:92`) — could carry an HTTP body. Tool runtime errors: outside this area, UNKNOWN | §4 |
| Retries resend identical prompt at temperature 0 | NOT CONFIRMED as stated: identical prompt yes (transport layer only, appropriate); temperature is the configured value (0.7 default), never forced to 0 | §7 |
| Foreign JSON envelope forced on a differently-trained model | CONFIRMED with nuance: native OpenAI function schemas are always sent (`openai-http.ts:184-185`), rendered by the runtime's chat template; the text-tag recognizer is a rescue, never the instructed format (`provider-riders.ts:93` forbids text syntax); the CLI path DOES prompt-inject a `{"tool_calls":[…]}` envelope (`parse.ts:5`), for Claude only. Risks: `tool_choice: "required"` on turn 0 for agent ops (`openai-compat.ts:133-137`, `agent-runner/register-adapter.ts:96`) — honored by local runtimes? UNKNOWN; and the one-empty-response permanent no-tool latch (§7) | §3, §7 |

## Two-owner findings (for the consolidation list)
1. Text tool-call promotion: `tool-call-text-extractor.ts` vs `anthropic-client/parse.ts parseToolCalls`.
2. JSON arg repair: `tool-call-text-repair.ts repairJsonText` vs `tool-execution/arg-repair.ts repairJson` (admitted at `helpers.ts:30-33`).
3. "Model didn't act" detection: announced-only, reasoning-only, premature-completion, unresolved-tool-intent — four detectors, one concern.
