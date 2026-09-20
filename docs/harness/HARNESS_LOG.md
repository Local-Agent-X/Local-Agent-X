# Harness experiment log

Spec: `docs/harness/LOCAL_MODEL_HARNESS_BRIEF.md`. Audit: `docs/harness/AUDIT.md`. Every change to the harness is an
experiment recorded here with the Appendix B template, including the ones that failed. Runtime facts and the Phase 0
measurements live in `docs/harness/audit-notes/runtime-facts.md` and `docs/harness/phase0-evidence/`.

## Decisions on record

- 2026-09-19 — **Cloud escalation stays off by default.** Any escalation to another model is a kernel-governed
  action: shown, approved, default-deny while the context holds content read from files or pages this session.
- 2026-09-19 — **Protocols become code-sequenced in Phase 4**, bundled and typed packs first, SKILL.md bodies left
  free-form; the protocol-run eval category decides how far to go.
- Keep threshold for Phase 2 (paired per-task wins minus losses on the dev split): **to be fixed after the Phase 1
  baselines land**, before the first Phase 2 experiment.

## Test models

| id | tier today | quant | context pinned (planned) | role |
|---|---|---|---|---|
| qwen3.6:27b | medium (name regex) | Q4_K_M, KV f16 | 65,536 (fits to 131,072) | large local model, the user's chat model |
| qwen3:8b | weak (name regex) | Q4_K_M, KV f16 | 32,768 (native max 40,960) | small local model |
| grok (xAI) | strong | — | — | frontier ceiling |

Runtime: Ollama 0.34.2, RTX 5090 32 GB. Profiles get a `profile_id` and content hash once the loader exists (Phase 1
item 3); until then entries name the model id and quant.

## Phase 1 — measure first

### EXP-1 — token and latency plumbing for local endpoints
Date: 2026-09-19
Hypothesis: local runs record zero tokens only because usage is never requested from non-cloud endpoints and
Ollama's native counters are never read; requesting it costs nothing and makes every Phase 1 metric measurable.
Change: `stream_options.include_usage` is sent to every OpenAI-compatible endpoint, with a learned per-(baseURL,
model) fallback when a strict server 400s on it (`src/providers/adapters/openai-http.ts`,
`openai-param-rejections.ts`); `cached_tokens` and time-to-first-token ride the usage/done chunks into the turn
record as `promptCachedTokens` and `ttftMs` (`canonical-loop/adapters/openai-compat.ts`, `stream-once.ts`); a
`promptOverWindow` flag is set when the runtime reports more prompt tokens than its measured window
(`request-preflight.ts`, the /v1 truncation tell); Ollama's per-request counters are logged on the classifier path
with a warning when a load happened inside the call (`llm-dispatch/ollama.ts`); `eval/op-outcomes/run.mjs` collects
`ttftMs`, `maxPromptTokens`, `promptOverWindow`. No behaviour change on any path; no flag needed.
Models: qwen3.6:27b Q4_K_M / qwen3:8b Q4_K_M, Ollama 0.34.2.
Eval: none (infrastructure). Verified by unit tests (72 across 9 files) and a live isolated-server run.
Before → After (isolated server, qwen3:8b, the three-message capture from the audit, `phase1-evidence/exp-1-wire-capture.qwen3_8b.json`):
  local turns recording tokens: 0 of 4 → 4 of 4 (17,206 / 17,309 / 23,655 / 23,713 prompt tokens)
  cached prompt tokens per turn: unrecorded → 0 / 17,199 / 1 / 11,813 — the within-op hit and the cross-message
    loss the audit read from Ollama's log are now in the harness's own record
  time-to-first-token per turn: unrecorded → 10,584 / 106 / 2,539 / 2,004 ms
  promptOverWindow: unrecorded → absent on every turn (nothing truncated)
  classifier calls: no counters → `[ollama] usage … prompt_eval=580 … load_ms=4 num_ctx=40960` per call
Decision: keep
Notes / surprises: the first draft reused `cacheReadTokens` (Anthropic's cache-read count, reported beside input
tokens and priced on top of them by `cost-tracker.ts`) for OpenAI's `cached_tokens`, which are a slice INSIDE
`prompt_tokens`. Blast-radius on the field found the cost ledger as a cross-concern consumer: every cloud provider
that reports cached tokens would have been billed for them twice. The count now has its own field,
`promptCachedTokens`, the ledger is untouched, and the eval metric reads either.

### EXP-2 — per-turn trace on the op store, and a viewer
Date: 2026-09-19
Hypothesis: a run cannot be replayed or diffed as the model saw it because nothing persists the prompt as sent,
the raw answer, or the thinking; adding that beside the turn record makes every later experiment inspectable
without Ollama's own log.
Change: `TurnResult.trace` on the adapter contract (request as composed, the body that went on the wire, raw
text before extraction, text after, thinking, tool calls, stop, usage, first token, timing), built by
openai-compat (`adapters/openai-compat/turn-trace.ts`), persisted by the store as
`op-turns/<idx>.trace.json.gz` after the durable commit (`canonical-loop/turn-trace-store.ts`, `checkpoint.ts`),
stamped with a run id (`LAX_RUN_ID` from a rig, else per boot), off with `LAX_TRACE_TURNS=0`; `scripts/lax-trace.mjs`
`list` / `show <op> [--turn N] [--prompt]` / `diff <a> <b>`. No behaviour change on any path.
Models: qwen3:8b Q4_K_M, Ollama 0.34.2 (the 27B path is identical code).
Eval: none (infrastructure). Verified by 129 tests (store, viewer, adapter, commit-path durability and hard-kill
recovery, adapter boundary audit) and a live isolated-server capture.
Before → After (`phase1-evidence/exp-2-wire-capture.qwen3_8b.json`, `exp-2-trace-turn0.qwen3_8b.json`):
  turns with a trace artifact: 0 → 8 of 8, all stamped with the rig's run id
  what a turn 0 trace holds for the 8B: system prompt 47,966 chars; 1 message; **65 tools**; temperature 0.7;
    max_tokens 11,299; thinking 1,288 chars before a `project_list` call; usage 23,528 in / 286 out / 7,129 cached;
    first token 3,092 ms
  viewer `diff` on two consecutive ops: system prompts diverge at char 47,754 of 47,966 (the dynamic tail),
    tool lists identical
  on the wire (final capture at af70f931): `{"model":"qwen3:8b","temperature":0.7,"max_tokens":11299,"stream":true,
    "stream_options":{"include_usage":true}}` with 65 tools and **no reasoning_effort** — the composed request said
    `medium`; the runtime's default (thinking on) is what the model ran under
Decision: keep
Notes / surprises: (1) the first trace confirmed the audit's RAG-warm cap bypass on the wire — the weak tier
received 65 tools, not 9, and the model's own thinking shows it choosing `project_list` from that list; (2) the
trace first recorded the request as the canonical adapter COMPOSED it (`reasoning_effort=medium`) while the HTTP
adapter's family regex withholds that param for qwen3, so the HTTP adapter now reports the body it actually sent
and the trace stores it as `request.sent` — the wire truth, not the intent.
