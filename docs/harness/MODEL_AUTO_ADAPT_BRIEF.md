# LAX — Pick a Model, the Harness Does the Rest

**Status:** proposed 2026-09-26, not started. Companion to `LOCAL_MODEL_HARNESS_BRIEF.md`. This brief
replaces that brief's section 8 (Phase 6) as the plan for capability profiles and auto-probe.
**Owner decisions still open:** section 9.

---

## 0. The goal

A user picks a local model. They set nothing else. The harness works out the window, the prompt and
tool budget, sampling, thinking, message shape, the tool-call format, the cache strategy and how
strict to be. That holds for any model on any supported runtime, including models nobody here has tried.

Success is measured, not asserted (section 10). A model that was never used to design the rules gets,
with zero configuration, results within a few points of a hand-tuned setup, and both safety gates stay
at zero.

## 1. Principles

1. **Facts, not names.** Every decision reads a fact the runtime reports or the harness measured:
   parameter count, served window, capabilities, template, architecture. Never a model-name match.
   There are too many models to tune one at a time.
2. **Rules, not tables.** Settings are derived by a small set of rules from those facts. A hand-written
   per-model profile is a test reference and an escape hatch, not the mechanism.
3. **Read before building.** The chat template, the model card and the runtime docs answer most
   questions before any experiment (section 5). Evals confirm; they don't discover.
4. **Verify on the user's machine.** What the runtime can't say is checked by a short self-check on
   first use: does the model call tools in structured form, where does its reasoning land, how fast is it here.
5. **Safety stays deterministic.** The irreversible floor, approval cards, taint and the kernel hold
   whatever model is plugged in. Adaptation can only make a model's policy stricter, never looser.
6. **One loop.** No per-runtime or per-family forks. Differences are data read by the one loop.

## 2. What already exists

| Piece | Where | What it does today |
|---|---|---|
| Discovery | `src/local-runtimes/discovery.ts`, `ollama-probe.ts`, `openai-compat-probe.ts` | Finds runtimes. Per model it records the **served** window, runtime-declared tool support, embedding-only, size and modified time |
| Certification | `src/local-runtimes/certification-*.ts`, the "Verify" button in Settings → local runtimes | Five scenarios: baseline marker, strict JSON schema, required tool call, tool-result continuation, context degradation. **Manual.** A pass only gates failover and background-classifier routing; it tunes nothing |
| Profiles | `src/local-runtimes/model-profile.ts`, `config/model-profiles/*.json` | Bundled and user profiles, matched by model identity across runtime spellings (EXP-26). Unprofiled local models get the kept defaults: mission routing, stable prefix, nudge, essentials |
| Live tool evidence | `src/providers/tool-capability-probe.ts` | Records that a model produced structured tool calls; probes once when there is no evidence |
| Residency | `src/local-runtimes/residency.ts` | Keeps the chat model loaded; background warms size the loaded window |
| Request fit | `canonical-loop/adapters/openai-compat/request-preflight.ts`, `local-cap.ts` | Refuses a request that can't fit the measured window; caps output to what is left |
| Stable prefix | `canonical-loop/chat-runner/local-prompt-split.ts` | Per-turn sections ride a trailing row so the head stays byte-stable |
| New-chat pre-warm | `src/local-runtimes/prompt-prewarm.ts` (EXP-28, being measured) | Replays the fixed head when a new chat opens |

The gap is not the pieces. Nothing connects *discover → derive → verify → learn* at the moment a model
is picked.

## 3. What goes wrong today, by class

Status: **seen** means observed in this campaign; **suspected** means expected from docs or templates, unverified.

| # | Class | Example | Status |
|---|---|---|---|
| G1 | Message shape a template rejects | Local requests end `user, user`: the trailing context row follows the user's message. Strict-alternation templates (Gemma, Mistral families) raise on that under Jinja runtimes (LM Studio, llama.cpp) | trailing `user, user` **seen** in traces; the template failure **suspected** |
| G2 | Input the model can't take | Screenshots sent to a text-only build → LM Studio 400 | **seen** (EXP-26) |
| G3 | Window smaller than the prompt | LM Studio and llama.cpp load models at 4k–8k by default; our head is ~27k tokens | **suspected**: confirm the preflight message is clear |
| G4 | Tool-call dialect not recognized | Our text fallback is tuned to Qwen; gpt-oss (harmony), Mistral, Llama 3.x and Hermes each differ | **suspected**: gpt-oss never run |
| G5 | Reasoning in the wrong place | Thinking inside `content`, or in a field we don't read; thinking eats the output budget and truncates a tool call | **suspected** |
| G6 | Sampling ignored | One global temperature on every request; publishers ship recommended settings the runtime would otherwise apply | **seen** (config) |
| G7 | Size-blind budgets | 3–4B models get the same ~27k-token prompt and 32 tools | **suspected**: nothing below 8B measured |
| G8 | Hardware-blind window | A 65k window on a smaller GPU spills layers to CPU (~6 tok/s) | **seen** on this box before (a leaked runner) |
| G9 | Cache strategy by architecture | Hybrid models restore only near the end of the last prefill; plain attention reuses any prefix | **seen** (probe 2026-09-26) |
| G10 | Contention | Chat, voice and background jobs share one model and evict each other's cache | **seen** |
| G11 | Drift | `ollama pull` or a runtime upgrade changes weights, template or prompt layout under the same name | **suspected**; the Ollama 0.34 renderer change was **seen** |
| G12 | Quant blindness | A profile matches the name, not Q2 vs Q6 | **seen** (LM Studio Q6 vs Ollama Q4) |
| G13 | Missing services | An LM Studio-only install has no Ollama embedding model, so memory recall may be dead | **suspected** |
| G14 | Unmeasured safety | Gates measured on the Qwen family and muse only | **seen** gap |

## 4. The design

### 4.1 Discover (instant, on selection and on runtime change)

Extend `LocalModel` (discovery) with the facts below. Every field is nullable. Null means unknown and
selects the conservative rule, never an optimistic guess.

| Fact | Ollama | LM Studio | llama.cpp server | Recorded today |
|---|---|---|---|---|
| Served window | `/api/ps` context_length | `/api/v0/models` loaded_context_length | `/props` n_ctx | yes |
| Max window | `/api/show` model_info `<arch>.context_length` | max_context_length | (confirm) | no |
| Tools / vision / thinking | `/api/show` capabilities | `/api/v0/models` capabilities and type (confirm) | (confirm) | tools only |
| Parameter count | `/api/show` details.parameter_size | model metadata (confirm) | `/props` (confirm) | no; sizeBytes is not a parameter count |
| Weight quant | details.quantization_level | quantization | (confirm) | no |
| Architecture | model_info general.architecture | (confirm) | (confirm) | no |
| Chat template | `/api/show` template or renderer | GGUF metadata (confirm) | `/props` chat_template | no |
| Publisher sampling | `/api/show` parameters | preset (confirm) | (confirm) | no |
| Runtime version, model digest | `/api/version`, digest | (confirm) | `/props` build (confirm) | no |

Every "(confirm)" is a research item (section 5) before code.

### 4.2 Derive (pure functions of the facts)

| Setting | Rule (a starting point; each rule is an experiment) |
|---|---|
| Message shape | One normalizer at the request boundary emits strict user/assistant alternation for every local request. It merges adjacent same-role rows and keeps the trailing context as the last block of the final user turn. It applies to all models; alternation is legal in every template |
| Images | Sent only when the model reports vision. Otherwise the tool that produced the screenshot says it can't be shown to this model |
| Window | Ollama: the largest of 64k, 32k or 16k that the free VRAM holds with the model resident. Other runtimes: the served window. The prompt budget is derived from it. A head that can't fit fails with one clear message naming the setting to change |
| Prompt and tool budget | By parameter count: 20B and up keeps today's head and essentials; 7–20B gets essentials; under 7B gets a reduced head and a smaller pinned set. Unknown counts as 7–20B |
| Tool-call reading | Structured calls from the runtime first. The text fallback recognizes every major family's dialect, in the one vocabulary module (`tool-call-text-tags`) |
| Reasoning | Read every field runtimes use for reasoning, and strip inline thinking tags from the reply. Thinking is on for planning turns when the model reports thinking and the output budget allows |
| Sampling | Send nothing unless the user set it, so the runtime applies the publisher's settings. A rule may override only with a measured reason |
| Cache strategy | Plain attention: the stable prefix is enough. Hybrid or recurrent architectures: stable prefix plus the new-chat pre-warm |
| Strictness | Starts at the tier floor and can only be raised (4.3) |

### 4.3 Verify (a background self-check on first use and on drift)

Extend the existing certification rather than adding a second prober. Run it **automatically** the first
time a model is selected, and again whenever the runtime version, model digest, quant or window changes.
Budget one to two minutes. Add these scenarios to the five that exist:

- structured tool call versus a typed-out call, five times, which sets the tool-call reading mode;
- where reasoning lands: content, a reasoning field, or nowhere;
- decode speed and time to first token at the derived window, which steps the window down if it spills;
- one injection bait in a file and one vague delete. A failure raises strictness, meaning more approval
  cards. It never blocks the user from the model unless Peter decides otherwise (section 9).

The result is a **learned profile** in the user's data dir, keyed by model identity, digest and runtime
version. Precedence: user override, then learned, then derived, then bundled. Bundled profiles stay
authoritative for the two reference models until the derived and learned result matches them on smoke.
After that they are test fixtures only.

### 4.4 Learn (live)

Real turns keep adjusting the learned profile: tool-call parse rate, truncated replies, typed-out calls,
first-token times, preflight refusals. The live tool evidence grows into this. A sustained shift re-runs
the self-check.

## 5. Research first

Before each work item, a research pass writes a short cited brief in `docs/harness/research/` from the
sources below. Code is written once, against documented behavior.

- **Chat templates** in each model's Hugging Face repo (tokenizer_config or chat_template): roles,
  alternation, tool rendering. The transformers chat-templating docs explain how to read them.
- **Tool-call dialects:** the vLLM tool-calling parser catalog, the llama.cpp function-calling docs, and
  OpenAI harmony for gpt-oss.
- **Sampling and template bugs:** model cards, and Unsloth's per-model run guides.
- **Runtime facts:** the Ollama API docs and FAQ, the LM Studio REST API docs, and the llama.cpp server
  README, including context checkpoints for hybrid and sliding-window models.
- **Capability datasets:** LiteLLM's model map (vision, function calling, context).
- **Measured harness design:** Aider's per-model settings file and leaderboards; the SWE-agent paper
  (interface design moves success); BFCL and tau-bench for which families can run a tool loop at all.

## 6. Work order

Each item is one experiment: a flag or rule, smoke while iterating, full on both test models, log, keep
or revert. A gate regression means revert or check in.

| Step | Items | Why in this order |
|---|---|---|
| A. Wire correctness | G1 alternation normalizer, G2 vision gate, G3 window message, G5 reasoning reader, G4 dialects | Outright failures today |
| B. Discovery | The 4.1 facts on both runtimes, plus drift fields (G11, G12) | Everything after reads them |
| C. Derivation | The 4.2 rules: sampling (G6), budgets (G7), window from VRAM (G8), cache strategy (G9) | The zero-config core |
| D. Self-check | Auto-run certification with the new scenarios; the learned profile | Covers what facts can't |
| E. Live learning | 4.4, a contention scheduler (G10), an embeddings fallback (G13) | Keeps it right over time |

## 7. The verification panel

The comparability track stays as it is: the 27B and the 8B on Ollama Q4_K_M, same rig, same holdout
discipline. Beside it, for breadth, a rotating panel of families on both runtimes runs at smoke to prove
the rules generalize.

| Family | Why |
|---|---|
| gpt-oss-20b | Most-used local model; harmony format |
| Gemma (current) | Strict alternation; system-role handling |
| Mistral or Devstral | Strict alternation; its own tool dialect |
| Llama 3.x 8B | A common default |
| A Qwen 4B-class model | Below today's floor (G7) |
| One model never used to design the rules | The honest test (section 10) |

Downloading each model needs Peter's go-ahead (disk and bandwidth).

## 8. Security constraints

Unchanged from the main brief, plus:

- A learned or derived profile can only **tighten** strictness relative to the tier floor, never loosen it.
- The self-check's safety scenarios are signals for strictness, not the guarantee. The deterministic
  floors are the guarantee.
- The panel runs on isolated servers only, never against the live data dir.

## 9. Decisions for Peter

1. Does the first-use self-check run silently, or show a short "tuning for your model" status?
2. A model that fails the self-check's safety scenarios: usable in a stricter mode (proposed), or
   blocked until the user confirms?
3. Downloads for the verification panel (section 7): which families, and a disk budget.

## 10. Definition of done

- Picking any listed local model needs no other setting, on Ollama and on LM Studio.
- G1–G5: zero outright failures across the panel at smoke.
- A model never used to design the rules scores within about 5 points of a hand-tuned profile on smoke,
  with zero configuration.
- `injection_executed` and `unsafe_action` at 0 on every panel model.
- The self-check finishes in under two minutes on this box and re-runs on drift.
- An "adding a new local model" guide that says: pick it, and nothing else.
