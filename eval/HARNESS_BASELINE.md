# Harness baseline — local models (Phase 0)

> Superseded 2026-09-19 by `docs/harness/AUDIT.md` (Phase 0 of `docs/harness/LOCAL_MODEL_HARNESS_BRIEF.md`). The measured muse numbers below still stand; the `resolveBackgroundModel` order and the classifier-site table are out of date (H-030 removed auto-selection; review calls run on the worker).

Mission: `docs/agent-prompts/local-model-harness.md`. Ledger: `eval/HARNESS_LEDGER.md`.
Gathered 2026-09-17.

## Runtime and models

- Ollama 0.34.1 on an RTX 5090 (32 GB). User settings: `provider: local`,
  `model: muse-glimmer:30b`, `localClassifierModel: llama3.2:3b-classifier`.

| Model | Params | Quant | Max ctx | Capabilities | Prefill tok/s | Decode tok/s | TTFT |
|-------|--------|-------|---------|--------------|---------------|--------------|------|
| muse-glimmer:30b | 27.9B | Q4_K_M | 131k (loaded at 65,536) | completion, vision, tools, thinking | ~4,200 | ~76 | <10ms warm |
| qwen3.6:27b | 27.8B | Q4_K_M | 262k | completion, vision, tools, thinking | TBD | TBD | TBD |
| gpt-oss:120b | 116.8B | MXFP4 | 131k | completion, tools, thinking | TBD | TBD | TBD |
| llama3.2:3b-classifier | 3.2B | Q4_K_M | 131k (loaded at 16,384) | completion, tools | ~23,000 | ~400 | <10ms warm |
| llama3.2:3b | 3.2B | Q4_K_M | 131k | completion, tools | TBD | TBD | TBD |
| mxbai-embed-large | 334M | F16 | 512 | embedding | — | — | — |

Measured 2026-09-17 on an idle GPU at each model's loaded context, via Ollama's
prompt_eval/eval counters. muse: a 12k-token prompt with 400 tokens out took 8.1s
(think off; think on was the same for this prompt). An earlier "~10 tok/s" figure was
measured under contention and is void. qwen3.6 and gpt-oss not yet measured (loading
them evicts muse).

Implication: a compaction summary on muse (~9k in, ~900 out) is ~14s, and review gates fit
40s comfortably with thinking off. The review gates' timeouts (H-016) are budget spent on
thinking or contention, not model speed.

## Where models judge models

Every background call goes through `classifyWithLLM`
(`src/classifiers/classify-with-llm.ts`), `classifySchema`
(`src/classifiers/schema-output.ts`), or `dispatch` (`src/llm-dispatch.ts`).

**Model choice.**
- `resolveBackgroundModel` (`src/providers/background-model.ts`) resolves in this order:
  1. the provider's declared `backgroundModel` (every cloud provider has one: haiku,
     gpt-4o-mini, …)
  2. for local only: the pinned `localClassifierModel`
  3. a certified small local target
  4. the smallest eligible discovered model
  5. the chat model
- `modelTier: "active"` selects the chat model.
- The yes/no helpers and `dispatch` have no tier option.

**Review/judgment sites on the background model** (break "judge ≥ worker"):

| Site | Category | What a wrong answer does |
|------|----------|--------------------------|
| context-manager/compaction.ts | compaction | Summary replaces history |
| canonical-loop/instruction-ledger/extract.ts | constraint-extract | Bans a tool class for the whole op |
| classifiers/test-deletion-classify.ts | test-deletion | Nudge + outcome label |
| classifiers/verify-by-refutation.ts via tool-policy/packs/egress-refutation-pack.ts | egress-refute | Blocks an outbound send |
| same helper via self-edit/refute-merge.ts | self-edit-refute | Holds a merge |
| self-edit/intent-gate.ts | self-edit-intent | Blocks self_edit (null also blocks) |
| auto-build/chunk-review/judgment-hook.ts | chunk-review-judgment | Gates a build chunk |
| auto-build/scenario-scorer/judge.ts | scenario-judge | Gates a phase (null = fail) |
| auto-build/advisor/index.ts | auto-build-advisor | Halts a build or amends the spec |
| auto-build/scenario-scorer/step-planner.ts | scenario-step-planner | Drives the scenario the judge scores (borderline) |
| tools/app-tools/vision-verify.ts (Anthropic only: haiku) | — | Forces a build retry |

**Review sites already on the chat model** (`modelTier: "active"`):

| Site | Category | Budget |
|------|----------|--------|
| classifiers/done-claim-audit.ts | spec-audit | 40s |
| classifiers/regression-audit.ts | regression-audit | 45s, or a configured second audit provider |
| classifiers/oracle-probe-gen.ts | oracle-probe | 40s |

On muse all three return nothing within budget (~75s wasted per op; see ledger H-016).

**Routing sites** (a mistake can't block or mislead the work; small model is acceptable):
- app-tier
- followup
- topical-relevance
- signal-confirm
- route
- curate-teach-moment
- end-of-turn-write
- identity-extract
- profile-compact
- contradiction-confirm
- correction-learning-confirm
- mission-validate
- schedule-nl
- memory extract
- memory resolver
- HyDE
- reranker (pins Ollama `qwen2:7b`, which is not installed here)
- protocol curator report

## Timeouts (inventory summary)

**Tools.**
- bash: 130s backstop above its own 120s kill.
- Unlisted tools: 120s.
- Long-runners: unbounded.
- Approval waits are excluded from tool deadlines.
- Timeouts abandon the work, they don't abort it.

**Classifiers.**
- Default 8s.
- Per-site budgets:

  | Site | Budget |
  |------|--------|
  | constraint-extract | 1.5s |
  | curate | 2s |
  | confirm-gate | 2.5s |
  | followup / test-deletion | 3s |
  | refutation | 4s × 3 |
  | compaction | 30s × 2 attempts |
  | spec-audit / oracle | 40s |
  | regression | 45s |
  | scenario judge | 20s |
  | advisor | 18s |

- Below 20s, a non-resident model is skipped and warmed in the background.
- `classifySchema` budgets are per attempt.
- Breaker: 3 failures → 60s pause per provider+model.

**Dispatch.**
- 30s default.
- Ollama `/api/generate` is non-streaming with one wall-clock.
- The num_ctx probe runs before that clock starts.

**Residency.**
- keep_alive 30m.
- Chat-model re-up every 4 min.
- Warm budget 60s (inside the observed 30–60s cold load).

**Loop.**

| Timer | Value |
|-------|-------|
| Interactive op wall-clock | 2h |
| Background/sub-agent ops | 15 min |
| Idle watchdog (no adapter report) | 600s — the only true idle timer |
| Lease / heartbeat | 60s / 10s |
| Transport retry | 3 attempts |

The OpenAI SDK on the Ollama chat stream uses its defaults (600s, maxRetries 2), with no
connect timeout.

**Rigs.**
- polyglot: 30 min per attempt × 2.
- op-outcomes: 15 min per turn.
- Server lifetime: was a fixed 45 min (H-017).
- Both drivers use a single wall-clock over SSE.

## Eval baseline (muse-glimmer:30b, polyglot curated 12, two attempts)

Run 16 is the first run on a build with fixes H-001…H-015. Rows so far:

| Exercise | Result | Class | Reason |
|----------|--------|-------|--------|
| grade-school | FAIL (stub untouched) | MODEL | Searched for the hidden tests for 70 turns and never edited |
| wordy | FAIL | MODEL | Error strings swapped |
| transpose | FAIL | MODEL | Drops leading padding |

Control (Grok 4.6, run 3): pass@1 11/12, pass@2 12/12, zero harness rows.
