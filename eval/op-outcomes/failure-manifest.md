# Model failure manifest

A bucketed catalogue of how the big-3 models fail on real tasks, so each failure
has an owner: a **registry-seed fact**, a **prompt/tool fix**, or a
**route-around**. Grounded in the `op-outcomes` battery runs in this directory
plus documented findings in code, commits, and project memory.

**Subject / contrast / control.** Grok is the subject (failures cluster here).
GPT is the contrast (does Grok's failure reproduce on it?). Claude is the
control — the "what passing looks like" baseline. A failure that Grok hits but
GPT **and** Claude clear is model-specific (→ fix/route it). A failure all three
hit is a hard task or a harness gap (→ fix the harness, not the model).

## Honesty caveats — read before trusting a number

- **Give-up/MISS rates are non-deterministic.** Consent/overlay walls render
  differently each load, so a single pass/fail is a coin flip. The numbers below
  are from specific dated runs, with variance shown — not ground truth.
- **The battery is weighted toward browser obstruction on purpose** (see
  `README.md`), so it over-samples Grok's worst axis. It is not a usage-weighted
  sample.
- Rows marked **(unverified)** need a live battery run to confirm root cause;
  they are not invented numbers, but the *cause* is inferred, not yet observed.

## Battery snapshot (PASS / total; g=gave-up m=miss e=err)

| run (UTC) | rep | grok | claude | openai (gpt-5.5) |
|---|---|---|---|---|
| 2026-06-25T12:35 | 1 | 11/13 (g1 m1) | 12/13 (e1) | 12/13 (e1) |
| 2026-06-25T13:57 | 3 | 31/36 (m5) | 36/36 | — |
| 2026-06-28T00:29 | 3 | 29/33 (g1 m3) | 33/33 | 27/33 (e6) |

Reading it: Claude is the clean control (the lone `e1` was an HTTP/timeout, not a
model defect). Grok loses points to **give-ups and wrong answers on browser**
cases. GPT never gives up or misses but **errors out** — all 6 errors in the
last run were the `research` category.

## Failure classes

Bucket key: **SEED** = registry capability fact (→ `src/providers/model-capabilities-seed.ts`) ·
**FIX** = prompt/tool-layer change · **ROUTE** = routing/adapter/auth choice.

### Grok (xai)

| # | Failure | Evidence | Bucket | Status |
|---|---|---|---|---|
| G1 | Punts a browser consent/overlay obstruction back to the user | battery give-ups (06-25, 06-28); memory `big-3-browser-comparison` | FIX | Improving — browser-wedge fixes `c87e3be3`, `383454c6`; give-up now intermittent, not chronic |
| G2 | Returns a **wrong/empty answer** on a browser task (MISS) | battery `m5` (06-25), `m3` (06-28) | FIX | **OPEN** — extraction-after-navigation; needs the MISS snippets triaged |
| G3 | Narrates a tool call as prose instead of emitting a structured call | `adapters/openai-compat.ts` Layer 2 (`proseLooksLikeToolCall`) exists for this | FIX | Shipped — wire-format nudge + visible annotation |
| G4 | `grok-4.20-0309-reasoning` 400s on `reasoning_effort` | `isReasoningEffortRejection` (openai-http.ts) | **SEED** | Shipped — in seed |
| G5 | Classifier calls timed out (ran the chat reasoner, 2.5s cap) | memory `completion-ledger-telemetry` | ROUTE | Fixed — classifiers routed to `backgroundModelFor` |
| G6 | Cost-blindness in outcome telemetry | memory `outcome-benchmark-report` | FIX | Fixed |
| G7 | Gave up after one `web_fetch` instead of delivering | memory `web-fetch-extraction` | FIX | Fixed at tool layer (`html-extract.ts`) |

### GPT (codex `gpt-5.5` / openai o-series)

| # | Failure | Evidence | Bucket | Status |
|---|---|---|---|---|
| P1 | `research` cases error out (timeout/HTTP) — 6/6 in last run | battery `e6` (06-28) | ROUTE | **OPEN (unverified)** — re-run `--only research --provider openai`, check `server.log` for the ERR cause (Codex OAuth eviction vs infra timeout) |
| P2 | o-series (`o3-pro`) 400s on a non-default `temperature` | `isTemperatureRejection` (openai-http.ts) | **SEED** | **Newly seeded this pass** |
| P3 | Codex OAuth is single-active-session; a second login evicts the first → runtime silently falls back to Grok | memory `big-3-browser-comparison`; battery fallback-guard | ROUTE | Known — battery guard skips mislabeled batches; verify real model via `server.log` `[chat-diag] prepared`, not self-report |
| P4 | Empty/truncated turn on Codex | `adapters/codex.ts` `MAX_TRUNCATION_RETRIES` | FIX | Handled — guided retry |

### Claude (anthropic) — control

No failure classes to fix. 33/33 and 36/36 across runs; the single `e1` (06-25)
was an HTTP/timeout, not a model defect. This is the reference for "passing,"
and the column that makes the other two classifiable.

## Registry-seed facts (the SEED-bucket rows)

These are the rows that became durable `(baseURL, model)` capability facts in
`src/providers/model-capabilities-seed.ts` — verified, public-endpoint, and
"negative capability" (a param/field the model rejects), so shipping them is
strictly safe:

- **G4** — `grok-4.20-0309-reasoning` rejects `reasoning_effort` (xAI)
- **P2** — `o3-pro` rejects non-default `temperature` (OpenAI)

When a future failure class is a hard provider-enforced rejection on a **public**
endpoint, add it both here (as a SEED row) and to the seed file. Local/Ollama
models are **not** seeded — their baseURL is per-user; the `/api/show` probe
(`providers/ollama-capability-probe.ts`) learns them on first use instead.

## Extending this

1. Run the battery: `node eval/op-outcomes/run.mjs --all --repeat 3` (see
   `README.md` — needs the dev server, spends real tokens).
2. Add a row per new failure class under the right model, with its evidence and
   bucket. Mark inferred causes **(unverified)** until a run confirms them.
3. Promote SEED-bucket rows to the seed file; leave FIX/ROUTE rows as the
   work-list for prompt/tool/routing changes.
4. Gemini and local models slot in as new model sections when they get battery
   coverage — the format is model-agnostic by design.
