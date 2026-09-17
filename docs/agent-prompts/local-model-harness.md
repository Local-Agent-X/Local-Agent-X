# LAX — Local Model Harness Stabilization Mission

You are working in the Local Agent X (LAX) repo at `C:\Users\peter\local-agent-x`. Your job is
to make local models run correctly through the LAX harness, then run evals in a loop until
every harness-caused failure is fixed. You are not here to make weak models smart. You are
here to make sure that when a model fails, it is the model's fault and not ours.

Read this whole document before touching anything.

## Context

- LAX is a local computer agent with full execution. Tool calls pass through the ARI kernel
  (`src/ari-kernel/`) and the security layer, which guard against prompt injection and unsafe
  actions. Kernel latency and wrongful kernel rejections are harness problems. A model that
  keeps retrying a deliberately blocked action after being told the alternative (e.g.
  `python -c` → "write a script file and run it") is a model failure.
- The agent loop lives in `src/canonical-loop/`, tool execution in `src/tool-execution/`,
  model selection for background work in `src/providers/background-model.ts` and
  `src/classifiers/classify-with-llm.ts`. Read `docs/codebase-map.md` first.
- Missions/protocols (`src/protocols/`) are reusable workflows and are part of the eval surface.
- The local runtime is Ollama. The default local model under test is `muse-glimmer:30b`.
  Grok (`--provider grok`) is the control: it scores 11–12/12 on the polyglot set, so a
  failure Grok does not have is worth a harder look.

## Ground rules

1. **Classify every failure** as one of:
   - `HARNESS`: anything outside the model's reasoning that changed the outcome. That means
     timeouts, wrong model routing, parse errors, context overflow or context loss, tool-call
     format mismatch, false constraints, path disagreements between tools, guards misfiring
     on harness-caused behavior, kernel misattribution, event-loop stalls, config bugs.
     You fix these.
   - `MODEL`: the model genuinely could not do it (wrong algorithm, wrong output shape,
     ignored instructions, gave up, genuine loop, false "done"). You do not "fix" these.
     Document them and make sure the harness fails gracefully (clear error, explicit flag).
   - `EVAL`: the test or rig is wrong, ambiguous, or leaks the answer. Fix it, state exactly
     why in the ledger, and never make it easier to pass.
2. **Never weaken a test, never edit model output, never special-case an exercise, never
   weaken a security control** to get green.
3. **Never use a weaker model to judge a stronger one** (Phase 2). No silent downgrades.
4. **One issue at a time**: reproduce → root-cause → fix the class → add a test that fails
   without the fix (prove it) → re-run the affected tests, then the eval → record.
5. **Prefer deterministic checks** (file exists, exit code, schema valid, test suite green)
   over LLM judgment. LLM-as-judge is the last resort.
6. **Keep a ledger** at `eval/HARNESS_LEDGER.md`: ID, symptom, classification, evidence,
   root cause, fix (files + commit), before/after result. It is a deliverable, not a log.
7. **Token discipline**: cache your understanding in the ledger; re-run the affected subset
   first, the full eval second.
8. **Extend, don't fork.** The eval rigs already exist under `eval/` (`aider-polyglot`,
   `op-outcomes`, and others). Build on them. Run `/canonical-check` before adding any
   subsystem-level file; a second eval framework or a parallel model router is a bug.

## Repo rules (non-negotiable)

- **Git.** Commit to `main`, no branches, never push unless asked. Commit messages end with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. When the build reports the codebase
  map is stale, run `npm run docs:map` and commit it.
- **Evals run only on isolated servers** (`eval/op-outcomes/isolated.mjs`), never against the
  user's live `~/.lax`. A live-server rig once wrote false facts about the user into their
  memory. Ask before deleting anything under `~/.lax` or the user's workspace.
- **Build order.** Commit, then `npm run build`. The rigs refuse a `dist/` that predates the
  source. Never rebuild while a run is active.
- **Stopping a run.** `TaskStop` kills only the shell wrapper. Also Stop-Process the
  `aider-polyglot/run.mjs` (or `op-outcomes/run.mjs`) node process and its `dist/index.js`
  child, then confirm none remain before rebuilding or measuring.
- **One GPU.** One exercise at a time. Never measure model speed while a run is active.
  Never pass a `num_ctx` different from what the model has loaded (it forces a reload that
  lands inside your timing). Use Ollama's own `prompt_eval_*` / `eval_*` timings.
- **Answer keys stay off disk.** The model's shell can search the whole disk:
  - The benchmark is a bare git clone read through `git show`.
  - Reports and evidence are gzipped (read them with `zcat` / `gunzipSync`).
  - Don't leave plain copies of tests or solutions anywhere.
- **Code hygiene.**
  - Files ≤ 400 LOC (`node scripts/check-source-hygiene.mjs`).
  - No `require()` in ESM.
  - Imports into canonical-loop go through `canonical-loop/index.js`.
  - Run vitest from PowerShell, not Git Bash.
  - `npx tsc --noEmit` before committing; `npm run build` is the full gate.
- **Heredocs corrupt backslashes.** Write regexes, Windows paths and `"\n"` strings with the
  file-edit tools, then syntax-check.
- **Ask the user only product, cost or risk questions** (e.g. "accept a multi-minute pause for
  a local summary?"). Decide engineering questions yourself and state the assumption.

## Phase 0 — Discover (no code changes)

- How LAX talks to Ollama. Where the chat model and background models are chosen. What the
  user's settings pin (`~/.lax/settings.json`, e.g. `localClassifierModel`).
- For each installed model (`ollama list`): param size, quant, context window, native tool
  calling, thinking support. Measure prefill tok/s, decode tok/s and time-to-first-token on an
  idle GPU. Measure each value; don't guess.
- Every timeout: value, what it wraps, what happens when it fires. Include tool timeouts
  (`src/tool-execution/tool-timeout.ts`), classifier and summarizer budgets, the adapter
  preflight, and rig timeouts.
- Every place a model evaluates, verifies, summarizes, or judges another model's work. Known:
  - compaction summaries
  - spec-audit, regression-audit, oracle probes
  - the instruction-ledger confirm
  - memory curation

  Find the rest.
- Run the existing evals once as-is. Capture raw results:
  - `node eval/aider-polyglot/scorer-selfcheck.mjs` (must print 12/12 OK)
  - `node eval/aider-polyglot/detector-selfcheck.mjs`
  - `npx tsx eval/aider-polyglot/run.mjs --timeout 1800000`
  - later, `npx tsx eval/op-outcomes/run.mjs`
- Write it all to `eval/HARNESS_BASELINE.md`, re-read it, and report the baseline before
  changing anything.

## Phase 1 — Timeouts and throughput

Fix timeouts structurally, not by making numbers bigger.

- Derive budgets from measured throughput:
  `prompt_tokens / prefill_tps + max_output_tokens / decode_tps`, times a safety factor
  (start at 2x). Keep per-model throughput in config, not in code.
- Where the runtime streams, use an idle timeout (no token for N seconds) instead of one
  wall clock. A slow model that is still producing tokens is not hung.
- Keep separate budgets for model generation, kernel inspection, tool execution, and human
  approval waits. One must never kill another. A tool's backstop must sit above the tool's own
  deadline.
- For a verdict or summary from a reasoning model, turn thinking off or budget for it. Burning
  the output budget on thinking returns an empty answer.
- Check context fit before sending. Compaction must leave the model the history it needs:
  - Without a summary, keep the longest tail that fits.
  - Never let a "you already have this file" stub or a replayed result stand in for content
    the model can no longer see.
- Cold start: pre-warm, or give a one-time load budget.
- Retry only on transient errors, never blindly on a timeout.

## Phase 2 — Model roles and judging

- Every background call declares its kind, with a coverage test so new calls can't skip it:
  - **Review/judgment** (summaries, audits, probes, constraint confirmation, anything whose
    wrong answer blocks or misleads the worker) must use the working model or a stronger one.
  - **Routing** (cheap yes/no triage whose mistake can't block the work) may use a small
    background model.
- If no equal-or-stronger model is available, the harness must:
  - (a) use a deterministic check,
  - (b) use a cloud model only if the user configured and allowed it, or
  - (c) skip the check and log it as `UNVERIFIED`.

  Silent downgrade is a bug. A small model's verdict may never add a restriction the user's
  words don't support.
- Capability tiers come from eval results, not param counts. Record the evidence.
- LLM-judged evals use a pinned, versioned prompt with structured output (pass/fail + reason).
- Once review calls use the working model, stop copying the user's `localClassifierModel`
  into isolated eval servers (`eval/op-outcomes/isolated.mjs`), so evals match any install.

## Phase 3 — Tool calling and structured output

- Per model: native tool calling, or the prompt-based format with the strict parser that
  already exists (`tool-call-text-tags` is the single recognizer; don't add a second).
- Bounded repair of malformed calls/JSON, every repair logged. Frequent repairs are tier data.
- Kernel and policy blocks reach the model as a clear tool result with the reason and the
  alternative. Eval output logs them as kernel events, not model errors. A block message must
  never invite a bypass.
- Tools must agree on paths. Shell spellings (`/c/...`, `/tmp/...`) and Windows spellings
  resolve to the same file in every tool and in the security gate.
- Missions authored on a strong model should degrade gracefully on a weaker one. Report where
  each breaks.

## Phase 4 — The eval surface (extend `eval/`)

- **Smoke tier** (minutes, deterministic), per model:
  - load
  - one completion
  - one tool call
  - one kernel-blocked call that comes back as a readable result
- **Harness tier** (tests us, not the model):
  - near-context-limit prompt
  - long output
  - streaming
  - cold start
  - malformed-tool-call recovery
  - a slow tool not killing the model call
  - kernel latency not counted against the model
  - compaction with the summarizer failing
  - a retry prompt that says "don't change the tests" not becoming a ban
- **Capability tier**:
  - `eval/aider-polyglot` (pass@1 / pass@2, Aider's two-attempt protocol)
  - `eval/op-outcomes` (everyday tasks)
  - a few real missions

  Failures here are `MODEL` unless the evidence shows a harness symptom.
- Every run is one command, per model or aggregate. Each run writes JSON plus a human summary
  and keeps evidence (op store + server log) for every non-pass. Every row is tagged with a
  suspected classification. The existing rigs already mark `HARNESS` (stalls, no turns) and
  `CONTAMINATED` (saw the hidden tests or searched outside the workspace).
- Temperature 0 and fixed fixtures where possible. No network beyond the local runtime (web
  tools are denied in the polyglot rig).
- Scope: muse first, Grok as the control. Add more local models only after muse is clean.
  Each full polyglot run is hours on one GPU.

## Phase 5 — The loop

1. Run the full eval. Watch rows as they land.
2. Triage every non-PASS row from its evidence before moving on. Evidence lives in
   `~/.cache/aider-polyglot-reports/evidence/<stamp>/<slug>/`. Look at:
   - `logs/server.log.gz`: stalls, DENY lines, summarizer failures, preflight refusals,
     classifier timeouts, loop aborts
   - `operations/*/op-turns/*.json.gz`: what the model called and what it was shown
   - the report row: `err`, `recovered`, notes, test output
3. Take the highest-impact `HARNESS` issue: reproduce it in isolation, fix the class, prove the
   test fails without the fix, run the affected tests, commit (ledger ID in the message).
4. For `MODEL`: confirm it is not a harness symptom in disguise. Does Grok hit the same
   harness-shaped error? Was the model misled by a block, stub, or lost context? Then document
   it.
5. For `EVAL`: fix the rig with justification. Run the self-checks.
6. If a fix changes the build a run is using, stop the run (see Repo rules), rebuild, restart.
   Otherwise let it finish.
7. Update the ledger. Regressions go to the top of the queue.

**Exit condition:**
- Two consecutive full runs with zero `HARNESS` rows.
- Every remaining failure has a one-line, evidence-backed `MODEL` reason.
- The op-outcomes battery is clean of harness failures too.

(Identical results across runs are not required. LLM agents vary run to run.)

**Stop on thrash.** If the same issue survives three attempts, write up what you tried and
what you think is happening in the ledger, and ask for input.

## Known state (update before each handoff; last updated 2026-09-17)

Already fixed:
- scorer interpreter
- isolated servers
- background jobs yielding to a running turn
- cubic history rebuild
- glob walking a whole drive
- `/tmp` path mismatch
- read-dedup stub claiming unseen content
- replayed stubs
- the open summarizer breaker sending an over-window view
- elision keeping too little history
- the ledger inventing a shell ban from "don't try and change them"
- answer key on disk
- contamination false positives
- recovered errors recorded as fatal

Open, start here:
1. **Review calls on the working model.** Split background calls into review vs routing and
   move review calls onto the working model (Phase 2). Today every background call uses the
   user's pinned 3B model, which loops when summarizing and invented a shell ban.
2. **Re-measure muse on an idle GPU.** An earlier "~10 tok/s" was measured under contention;
   the user sees much faster in LAX. Set summary and review budgets from real numbers.
3. **Review gates are no-ops.** oracle-probe, spec-audit and regression-audit return nothing
   on muse (~75s wasted per op). Make them fit the budget, or skip them and log it.
4. **Loop detection vs context loss.** Loop detection counts re-reads forced by lost context
   as looping. Decide with evidence (`src/tool-execution/model-view.ts` knows what the model
   can see).
5. **Retry protocol end to end.** Verify Aider's two-attempt retry now that the false shell
   ban is fixed.

## Final report

Write `eval/HARNESS_REPORT.md`:
- Baseline vs final pass rates per model and tier (pass@1 / pass@2).
- Ledger summary: found, fixed, deferred.
- Capability tiers, with the evidence behind each.
- Recommended routing on this machine: worker, judge, summarizer, router.
- What is still fragile, and why.

Start with Phase 0. Report the baseline before making changes.
