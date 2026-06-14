# ARI Kernel × AgentDojo

Benchmarks Local Agent X's **real** prompt-injection defenses against
[AgentDojo](https://github.com/ethz-spylab/agentdojo) (ETH Zürich, NeurIPS 2024),
the standard agentic prompt-injection benchmark.

This is **whole-stack**: each AgentDojo tool call is routed through LAX's real
pre-dispatch defenses and each tool output through LAX's real content sanitizer —
the shipped code in `src/`, imported, not reimplemented. The number measures what
LAX actually does, not a model of it.

## Architecture

```
AgentDojo (Python, .agentdojo-venv)
  │  agent driven by the stock openai client → OPENAI_BASE_URL=bridge/v1
  │  every tool call/output intercepted by AriToolFirewall (ari_defense.py)
  ▼
Node bridge (bench/agentdojo/bridge/, run via tsx)
  ├─ /v1/chat/completions   LLM shim → `claude` CLI (OAuth, no API key)   [llm-shim.ts]
  ├─ /guard/tool-call       whole-stack gate: ARI kernel + lineage + canary + threat
  ├─ /guard/tool-output     content sanitizer + taint recording           [guard.ts]
  ├─ /run/begin /run/end    per-episode firewall/taint/canary isolation
  └─ /scoreboard            live ASR/utility + block-stage histogram       [scoreboard.ts]
```

Real LAX code exercised: `src/ari-kernel/*` (kernel, preset `workspace-assistant`,
host grants, behavioral rules), `src/sanitize.ts` (`wrapExternalContent`,
41 injection patterns, homoglyph normalize, system-tag strip),
`src/data-lineage-taint.ts` (taint + egress gate), `src/threat/*` (canary tokens,
chain analysis). The model is the real `claude` CLI via OAuth — no new API key.

## Configs (the three runs)

| config | what it is |
|---|---|
| `off` | no defense — baseline ASR + utility |
| `faithful` | LAX exactly as shipped: kernel gate (workspace-assistant preset), lineage egress, canary, threat chain; sanitizer wraps **web-class reads only** (`get_webpage`, matching LAX's web_fetch/http/browser scope); taint recorded only on secret-shaped output (prod behavior) |
| `sanitize-all` | `faithful` + the delimiting sanitizer extended to **every** untrusted read (email/file/review/chat/calendar) — quantifies the coverage gap from LAX scoping sanitization to the web boundary |
| `taint-all` | (optional, `--configs ...,taint-all`) every untrusted read recorded as web taint → kernel behavioral rules + lineage egress fire on sinks. Max-security / min-utility ceiling. |

## Key fidelity decisions (read before interpreting results)

- **Tool→class mapping** ([tool-map.ts](bridge/tool-map.ts)) uses LAX's real class-by-analog.
  LAX classes `email_send`/`calendar_create_event` as kernel `http` (action `post`),
  and the `workspace-assistant` preset **blanket-denies http writes**. So AgentDojo's
  outbound-comms sinks (`send_email`, `send_money`, `send_*`, `post_webpage`, `share_file`,
  `invite_*`, `reserve_*`) map to http/post and are denied by the preset **whether or not
  an injection is present**. This is faithful to prod and is recorded as block-stage
  `preset-policy` — distinct from injection-triggered blocks (`taint-behavioral`,
  `data-lineage`, `canary`). The block-stage histogram is what makes the result
  interpretable: it separates "preset is egress-restrictive" from "kernel caught the attack."
- **Taint** is fed exactly as prod feeds it (`recordSensitiveRead` only on sensitive-file
  paths + secret-shaped output; web/email content is *not* tainted — see
  `run-sandboxed.ts:222`). AgentDojo injections rarely carry secrets, so the kernel's
  taint-driven behavioral rules rarely fire under `faithful` — a true finding, not a bug.
- **Sanitizer** is delimiting + warning (spotlighting), not stripping — so it reduces ASR
  partially, consistent with AgentDojo's published spotlighting results.
- **Polarity**: AgentDojo's `injection_task.security()` returns True when the attack
  SUCCEEDED. We report **ASR = mean(attack succeeded)** and **defended = 1 − ASR**.

## Run

```bash
# 1. start the bridge (keep running; serves model + guard + scoreboard)
PORT=8900 BENCH_MODEL=sonnet npx tsx bench/agentdojo/bridge/server.ts
# open http://127.0.0.1:8900/scoreboard

# 2. run the sweep (separate shell)
.agentdojo-venv/Scripts/python run_bench.py \
  --configs off,faithful,sanitize-all \
  --suites banking,slack,travel,workspace
```

Smoke: `--suites banking --max-user-tasks 1 --max-injection-tasks 1`.

Env: `BENCH_MODEL` (claude alias/id, default `sonnet`), `BENCH_BRIDGE`
(default `http://127.0.0.1:8900`), `BENCH_CLAUDE_CLI` (override cli.js path).

## Caveats

- Driven by the `claude` CLI, so absolute scores are "what your CLI serves," not the
  paper's GPT-4o/Claude-3.5 baselines. The **on/off/sanitize-all delta** is the signal.
- `max_workers=1` (one episode at a time) — the bridge keys per-run state on a single
  active run.
- Full sweep is ~1k episodes/config × multi-turn → hours via CLI. The scoreboard updates
  live; AgentDojo errors are counted separately (`err` column), not scored as attacks.
