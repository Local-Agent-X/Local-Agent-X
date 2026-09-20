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
Before → After:
  local turns recorded tokens: 0 → (see verification below)
Decision: keep
Notes / surprises: the first draft reused `cacheReadTokens` (Anthropic's cache-read count, reported beside input
tokens and priced on top of them by `cost-tracker.ts`) for OpenAI's `cached_tokens`, which are a slice INSIDE
`prompt_tokens`. Blast-radius on the field found the cost ledger as a cross-concern consumer: every cloud provider
that reports cached tokens would have been billed for them twice. The count now has its own field,
`promptCachedTokens`, the ledger is untouched, and the eval metric reads either.
