# Loop guards, stall handling, missions/protocols — Phase 0 audit (brief §2 Q7, Q8)

Read-only audit of `C:\Users\peter\local-agent-x` on 2026-09-19. Lines are 1-indexed, repo-relative. Every claim is VERIFIED by reading the cited line unless marked INFERRED or UNKNOWN.

## 1. Budgets

| Name | Value | What it wraps | When it fires | file:line |
|---|---|---|---|---|
| Per-tool timeout | bash 130 000; browser 30 000; web_search 15 000; http_request / web_fetch 60 000; read / write / edit / view_image 10 000; memory_search / memory_recall / search_past_sessions 30 000; **0 = unbounded** for self_edit, build_app, start/finalize_app_build, run_build_plan, op_submit*, op_wait, agent_spawn/create, delegate, swarm_create, exit_plan_mode, request_secret(s); unlisted 120 000 | `input.tool.execute(args, signal)` via `Promise.race` | Rejects `ToolTimeoutError` → `status:"timeout"` result row; the promise is **abandoned, the work is not killed** ("this backstop only abandons the promise") | `src/tool-execution/tool-timeout.ts:10-69`, `:71-72`; runner `src/tool-execution/tool-runner.ts:65-69` |
| Backstop above a tool's own deadline | `max(configured, args.timeout + 10 000)` | Same wrap when the call carries its own `timeout` | as above | `tool-runner.ts:21,31-36` |
| Approval-wait exclusion | wait time subtracted at the deadline: `startedAt + ms + (excludedMs?.() ?? 0) - Date.now()` | Human approval cards raised inside execute (AsyncLocalStorage scope) | Timer re-arms for the excluded span, once | `tool-timeout.ts:141-142`; `src/approval-wait.ts:34-66` |
| L1 tool retry | maxRetries 2, 500→4000 ms backoff, retryable effects only | one tool call | re-executes | `tool-runner.ts:79-86` |
| Iteration budget (`maxIterations`) | chat_turn 30; agent lane 30; delegation 30; build_app 50; verification 12; worker fallback 64 | turns per op | **NOT a cap** — a checkpoint cadence: `evaluateCheckpointStop`, stop only on `dry-checkpoints` (2 consecutive, `DRY_LIMIT`), `spend-ceiling`, else `count = 0` and continue | `src/canonical-loop/chat-runner/create-op.ts:60`; `agent-runner/run.ts:132`; `src/routes/chat/delegation-handoff.ts:45`; `src/tools/build-app.ts:56`; `verification-submit.ts:91`; `worker.ts:53,160-183`; `checkpoint-stop.ts:186,201-224` |
| Wall clock (`maxWallTimeMs`) | chat 7 200 000 (2 h, `LAX_CHAT_WALLCLOCK_MS`); agent lane 15 min; contextPack default 15 min; op_submit 15 min; **build_app 0 = never**; verification 300 000 (its own timer); chunk worker 30 min; autopilot 30 min total, round = remaining−30 s (min 60 s), maxRounds 20, maxNoopRounds 2 | whole op | Timer **plus** synchronous check at the turn boundary (starved loops never fire timers). Interactive → `failed/deadline_exceeded`; other lanes → `iteration_checkpoint{continuing:false,stopReason:"wall-clock"}` + `succeeded/partial` | `create-op.ts:14-17`; `agent-runner/types.ts:65`; `src/ops/context-pack-builder.ts:84`; `src/ops/tools/shared.ts:204`; `build-app.ts:56`; `verification-submit.ts:93,251`; `src/auto-build/agents/chunk-runner.ts:71`; `src/autopilot/start.ts:89-91`, `loop.ts:165`; `worker.ts:112-116,152-159`; `worker-wall-clock.ts:15-26,76-101` |
| Idle watchdog | 600 000 ms (`LAX_CANONICAL_IDLE_TIMEOUT_MS`) | one adapter call; reset on every report | `adapterError{code:"stalled"}` + `adapter.abort("idle-stalled")`; worker lanes → `suspend` (op paused), interactive → terminal error | `turn-loop/idle-watchdog.ts:53-55`; `turn-loop.ts:144-156`; `turn-loop/suspension.ts:37-48` |
| Provider HTTP timeout | none set: `new OpenAI({ apiKey, baseURL, ...fetch })` | — | SDK default (INFERRED ~10 min); the idle watchdog is the real hang-catcher; abort via `req.signal` | `src/providers/adapters/openai-http.ts:133`; `openai-compat/stream-once.ts:64` |
| Adapter-error recovery | thrown: cap 2; over-window forced compaction: cap 2; reported+retryable+zero activity → requeue via retry policy (values UNKNOWN: `ops/heartbeat.ts` RETRY_POLICIES not read) | model call | resume nudge / requeue / `adapter_retry_exhausted` → failed | `turn-loop/adapter-throw-recovery.ts:25,32`; `reported-adapter-recovery.ts:28-37`; `worker-adapter-retry.ts:33-50` |
| Gate-internal | build 180 000 & 2 retries; probe 30 000 & 2; render wait 3 000 & 2; design 3 retries; regression grep 15 000; review classifiers: done-claim 40 s, oracle 40 s, regression 45 s, test-deletion 8 s, refutation 10 s, constraint 6 s, compaction 30 s | one gate | see §6 | `build-verify.ts:42-43`; `spec-probes.ts:42-43`; `render-verify.ts:32-34`; `design-verify.ts:42`; `regression-audit.ts:63`; `src/classifiers/{done-claim-audit.ts:100,oracle-probe-gen.ts:124,regression-audit.ts:92,test-deletion-classify.ts:112,verify-by-refutation.ts:36}`; `instruction-ledger/extract.ts:320`; `src/context-manager/compaction.ts:66` |
| Eval rigs | aider-polyglot 1 800 000/exercise, server lifetime 2×+15 min, **healthy** = no loop-sentinel stall AND turns ≥ `max(3, driveSecs/120)`; op-outcomes turn 900 000 (case override 1 800 000), boot 180 000, sentinel profile at 4 000 ms (product 30 000); grok-parity 200–420 s/scenario; instruction-compliance 180–240 s | one drive | timeout → FAIL only when harness healthy ("did-not-converge") | `eval/aider-polyglot/run.mjs:52,118-127,135,198`; `eval/op-outcomes/run.mjs:39`, `cases.json:81`, `isolated.mjs:24,145`; `src/server/event-loop-sentinel.ts:66-67`; `eval/grok-coding-parity/scenarios.mjs:32-404`; `eval/instruction-compliance/scenarios.mjs:33-114` |

## 2. Repeated-action detection

One `LoopState` per op (`src/agent-guards/loop-detection.ts:40-113`), held in the middleware-state registry under `"loop-detection"` and cleared on op terminal (`src/canonical-loop/middlewares/loop-detection.ts:87`). Thresholds halve for `modelTier` weak/medium (`loopGuardTier`, `:85-86`).

| Signal | Threshold (strong / weak-medium) | Resets | Fires |
|---|---|---|---|
| Exact-repeat: same `{tool,args}` AND unchanged result sha1 | `identicalResultRepeats >= repeatLimit - 1`, repeatLimit 3 / 2 | any different key (`:191-195`) | interactive: nudge; worker: pivot armed |
| Cycle: same tool-name procedure, period 2–8, novelty-free span, ≥2 distinct shapes | `MIN_REPEATS` 3 / 2 | window cleared on fire (`:203`) | interactive nudge; worker: the ONLY pivot that advances the ceiling |
| No-progress | 25 / 15 iterations | **an edit resets only when it hits a NEW target**: `if (!state.seenMutationTargets.has(target)) newTarget = true` → `iterationsSinceProgress = 0` (`:236-237,247-248`); a novel result also resets; rewriting one path does not (`:228-232`) | nudge / worker pivot |
| Redundant search / discovery loop | pattern-keyed, `searchKeyCounts` **never reset** (`:65-70`); discovery 8 / 4 | spiralable counts reset on `isProgressTool` or prior-turn novelty (`:241-245`) | nudge |
| Lifetime nudge ceiling | `NUDGE_CEILING = 6` (`:131`) | never | hard abort even interactive (`:161-164`) |
| Worker pivot ceiling | 5 strategies (theory-falsification → context-refresh), cycle-armed only | novel tool result → `offered = 0` | abort with cycle note (`middlewares/strategy-pivot.ts:38-44,109-111,136-146`) |
| mutation-repeat (worker) | byte-identical successful committing call | — | pivot + `skipToolDispatch` — the model's calls are dropped (`middlewares/loop-detection.ts:89-93`) |
| dead-end | 3 empty results | counter zeroed on fire | nudge, all lanes (`agent-guards/dead-end.ts:43`; `middlewares/dead-end.ts:5-8`) |
| repeat-failure: same tool family + same error head, args ignored | NUDGE_AT 3, ABORT_AT 5 | same-family success | nudge → abort (interactive) / suspend (worker) (`middlewares/repeat-failure.ts:32-33,80-103`) |
| repeat-output: token-set Jaccard ≥ 0.9 vs last 4 turns | 2 → nudge, 4 → abort, every lane (`repeat-output.ts:31-35,84-101`) |
| thrash-guard: setting flip after failure, then refail | 2 / 4 cycles (`thrash-guard.ts:32-33`) |
| mid-turn-stale | after 5 turns, 3-turn flat evidence window; browser-only monotony (`mid-turn-stale.ts:33-45`) |
| budget-ladder | rungs at 25/50/75 % of `maxIterations` (only ≥ 40), 2 dry rungs → stop nudge (`budget-ladder.ts:43,47,117-119`) |

Nudge budget (`src/canonical-loop/turn-loop/nudge-budget.ts`): pools `chat_turn: 4, app_build: 16`, else 8 (`:29-33`); exempt reasons `adapter-retry`, `reported-adapter-retry` (`:35`); self-bounded `budget-ladder`, `loop-detection` (`:51`); verdict pool 2 for `build-verify, spec-probe, spec-audit, regression-audit, design-verify` then the shared pool (`:68-69,83-86`). The single seam that charges them is the only writer of a nudge row:

```
src/canonical-loop/turn-loop/nudges.ts:47
  if (!consumeNudgeBudget(opId, source)) return false;
```
Every producer funnels through `appendNudgeAsUserMessage`: beforeTurn (`turn-loop.ts:121`), post-commit directives (`apply-directive.ts:45`), completion gates (`decide-outcome-verify-gates.ts:65,80,113,135,159,178`), failure summary (`decide-outcome.ts:276`), reasoning/announced-only (`empty-turn-termination.ts:125,195`), pivot replay (`nudges.ts:88`). A refused nudge writes nothing, earns no fire, and the turn ends on what it has. Note the pool is per **op**, i.e. per user message on chat.

## 3. Stall detection

- **Event-loop stall profiler**: process-wide 500 ms sampler, warn 5 000 ms, CPU-profile at 30 000 ms, 10-min cooldown, keep 12 (`src/server/event-loop-sentinel.ts:65-77`); an off-thread worker logs stalls in progress and distinguishes system sleep (`:26-42`). Rolling pre-armed profile is opt-in (`LAX_LOOP_SENTINEL_ROLLING=1`, 30 s windows, `rolling-stall-profile.ts:7-20`). Lease heartbeat logs lateness (`worker-heartbeat.ts:60-70`). All DIAGNOSTIC — none ends an op.
- **Model idle**: the idle watchdog above (§1).
- **Silent turns (interactive only)**: fully empty (no text, no tool, no reasoning) → ONE silent re-drive, then honest terminal (`empty-turn-termination.ts:203-214`); reasoning-only (H-024) → `REASONING_ONLY_LIMIT = 2`: one nudge "Continue from your plan…", then done (`:35-37,188-201`); announced-only (H-033) → one nudge per op, only when the op has dispatched no tool, reply ≤ 90 chars single sentence or a bare command line ≤ 300 chars, not a question (`:57-60,79-98,116-129`), evaluated BEFORE the done gate (`decide-outcome.ts:217-229`).
- **Worker-lane silent turns**: premature-completion (once, worker only, `middlewares/premature-completion.ts:20-31`) and the earned-done gate on open task steps (`decide-outcome-gates.ts:123-133`).
- **Hung provider call**: idle watchdog → `adapter.abort`; thrown error → `recoverAdapterThrow` (cap 2, resume nudge); reported retryable error with zero activity → `retryCode` → requeue; over-window → forced compaction ×2 (§1 rows).

## 4. Missions / protocols

**Representation** (`src/protocols/types.ts:10-25,71-104`): `Protocol {name, description, triggers[], steps[], rules[], learnablePreferences[], body?, allowedTools?, source, category?, tags?, supersedes?, pinned?}`; `ProtocolStep {id, instruction, suggestedTools?, requiresUserAction?, validate?, condition?, elseStep?, nextStep?}`. Four tiers merged by name: builtin typed packs → bundled SKILL.md → imported SKILL.md / managed learned → custom (`loader.ts:1-26`). SKILL.md parses to `steps: []` with the body verbatim (`skill-md-parser.ts:9-12,120`).

**Execution = one prompt to the model.** `protocol_get` renders rules + steps as text:
```
src/protocols/index.ts:225
  `  Step ${i + 1} [${s.id}]: ${s.instruction}${s.requiresUserAction ? " ⏸️ (needs user action)" : ""}${s.validate ? `\n    ✓ Validate: ${s.validate}` : ""}`
```
`condition`, `elseStep`, `nextStep`, `suggestedTools` are never rendered; `validate` is rendered as prose. `resolveNextStep`/`evaluateCondition` have no caller outside `dryRunProtocol` (grep over `src`), and `protocol_dry_run` is a preview (`index.ts:331-356`). Branch logic is dead at runtime. Body protocols return `body` and skip steps entirely (`:218-221`).

**State across steps**: `progress.ts` keeps an in-memory `executions` Map (`:30`) advanced only when the model itself calls `protocol_progress_start/update` (`:156-198`); `chain.ts` same shape (`:30,148-190`). Nothing in the turn loop reads either; nothing is persisted or re-injected. Cross-step state is the model's context.

**Slot filling**: `{{var}}` interpolation exists only as the `protocol_var_interpolate` tool (`variables.ts:75-85,158-172`); prefs are appended to `protocol_get` output (`index.ts:201-205`). No code-side slot schema.

**Tool constraint — FINDING (two owners, one stale).** `types.ts:85-88` says `allowedTools` is "Enforced via session policy on protocol_get". It is not: `protocol_get` (`index.ts:176-232`) never touches session policy; the only production caller of the whitelist API is `clearSessionAllowedTools(sessionId)` (`src/routes/chat/run-chat-turn/orchestrator.ts:345`), and no non-learned reader of `.allowedTools` exists. The only enforcer is the **learned** envelope: `if (!envelope.allowedTools.includes(ctx.tc.name))` → blocked (`src/tool-execution/learned-protocol-envelope.ts:40-55`), registered at `protocol_get` for learned records only (`index.ts:181-189`). Bundled SKILL.md `allowed-tools` (`bundled/app-build/SKILL.md:5-11`) is parsed and ignored.

**Selection**: a harness notice "LEARNED WORKFLOW … load it via the protocol tool", body deliberately omitted (`src/agent-request/prepare-request/build-context.ts:115-133`).

**Repo-root `protocols/`** is the workspace tier written by `resolve(cfg.workspace, "protocols", …)`: `custom.json` = custom typed store (`builder.ts:4,33-35`) holding one `dry_audit` record whose `steps` are plain strings (not `ProtocolStep`) masked by its `body`; `usage.jsonl` = append-only telemetry (`usage.ts:2-23,56-63`), 28 `invoked` rows, always `brownfield`+`git_workflow` 2 ms apart, 2026-07-25 → 2026-09-07 (an automated caller, INFERRED); `imported/` = 6 SKILL.md packs; `effectiveness/` empty (`learned-effectiveness.ts:69`). Why the repo root rather than `./workspace`: UNKNOWN — the writing process had `cfg.workspace` = repo root (`LAX_WORKSPACE`, `src/config.ts:107`); settle by checking that env in the eval rigs / settings.

**Split**: code does load, render, prefs lookup, usage logging, and (learned only) a tool whitelist; sequencing, branching, validation, slot filling and state are all the model. Estimate **≤ 10 % deterministic / ≥ 90 % model**.

## 5. Auto-build vs a protocol

Phases: `start_app_build` returns the SKILL.md body + framing for a model-driven planning conversation (`app-build-tool.ts:84-140`) → `finalize_app_build` validates `plan_md` with the loop's parser (`:265-281`), materializes spec/scenarios/twins/plan, kicks the orchestrator → `runBuildLoop`: git baseline, preflight probe, per chunk `runChunkAgent` (canonical agent, `allowedTools: ["read","write","edit","glob","grep","bash"]`, 30 min) → review → proceed / amend_spec / push_back (once) / halt (`loop/run.ts:1-22,129-216`; `chunk-runner.ts:153,71`).

| Check | Kind | Evidence |
|---|---|---|
| report-shape, done-when, additive-diff, phase-gate, launch-readiness, test-failures, spec-gap phrases | deterministic string rules over the worker's report (trusts attestation) | `chunk-review/gates.ts:70-96,122-185,200-227,238-278,297-336`; `gate-done-when.ts` |
| build-exec | deterministic ground truth: `npm run build`/`npm test` exit codes + headless smoke; only elevates proceed→halt | `gate-build-exec.ts:148-209` |
| judgment hook | model judge, `role:"review"`, 12 s, only elevates proceed→amend_spec ("mechanical-as-floor") | `judgment-hook.ts:111-122`; `chunk-review/index.ts:100-171` |
| scenario scorer | Playwright driver; per-step LLM planner (review, 10 s) + one-shot LLM judge 0–10 (review, 20 s), pass ≥ 7, 5 min/scenario | `step-planner.ts:49,127-138`; `judge.ts:45,144-155`; `scorer.ts:15-16` |
| advisor | model, review, 18 s; fallback `try-fix-worker`; 2 attempts then halt | `advisor/index.ts:35,131-141`; `loop-phase-gate.ts:64-135` |
| systemic halt | deterministic: 3 same-gate halts → blocked | `kickoff.ts:116-136` |

Difference from a protocol: code-side step sequencing (chunks from `plan.md`), code-side state (git shas, outcomes, `.lax-build-history.json`), a code-enforced worker tool set, and deterministic gates as a floor with model judges only above it. Protocols have none of these.

## 6. Verification in the ordinary chat op

Chain (`decide-outcome-gates.ts:241-260`): render-verify → build-verify → spec-probe → spec-audit → regression-audit → design-verify → unresolved-tool-intent → earned-done → late-inject → framework-serve. Runs only once `terminalReason === "done"`, short-circuits on the first reopen, skipped when the turn ends on a question (`decide-outcome.ts:302-303`).

| Gate | Check | Model (H-016) | Verdict |
|---|---|---|---|
| build-verify | deterministic: LSP outstanding errors fast-fail, then the project's build/type-check, then tests if a test file was edited | none | **labels** (`recordOrchestratorVerify` clean/partial `build-verify.ts:274,337`), nudge + reopen ≤ 2, retry-reframe is a deterministic error-signature diff (`:100-127`) |
| spec-probe | model authors an implementation-blind probe, harness **executes** it; INVALID discarded | `role:"review"` = the active chat model, 40 s (`oracle-probe-gen.ts:119-124`) | nudge only ≤ 2, no label (`spec-probes.ts:19-25`) |
| spec-audit | model re-reads request vs diff, once per op | review, 40 s (`done-claim-audit.ts:96-100`) | nudge only (`spec-audit.ts:14-22`) |
| regression-audit | model over diff + deterministic consumer grep; opt-in second provider | review, 45 s | nudge only, once (`regression-audit.ts:21-33`) |
| render-verify | deterministic: preview runtime errors / headless probe (vision judge inside — `vision-verify.ts` not read, INFERRED) | — | nudge ≤ 2, then `gave-up`, done stands |
| design-verify | vision score from the render probe, threshold ≤ 3, ≤ 3 retries | vision judge (INFERRED) | nudge only, no label (`design-verify.ts:12-17,38,42`) |

`role:"review"` resolves to the worker's model: `const explicitModel = opts.model || (opts.role === "review" && ctx.model) || "";` (`src/classifiers/classify-with-llm.ts:210`); routing → `resolveBackgroundModel`. A per-(provider,model) breaker returns null → gate no-op (`:124-130,224`). These five draw the verdict pool first (§2).

## 7. Footguns

- **History grows forever, no compaction / no state block** — NOT PRESENT on interactive/agent/background: threshold compaction exists (`compact-history.ts:1-10`) and a code-maintained per-op state block is appended every turn as an ephemeral trailing user row — pace, last 8 actions with ✓/✗, up to 12 open plan steps, goal restatement after turn 3/4/6 by tier, success criteria and constraints (`situational-awareness.ts:20-23,65-71,141-158`; `build-input.ts:162-181`). **CONFIRMED on the `build` lane**: "The `build` (app-build) lane stays out" (`build-input.ts:149-150`).
- **Retries resend the identical prompt at T=0** — PARTIAL. Temperature defaults to 0.7, not 0 (`openai-compat.ts:150`; `openai-http.ts:191`). Every nudge re-drive appends ≥ 1 user-role row (`nudges.ts:61-65`) and the digest changes per turn. One identical re-send exists: "First empty non-done turn: leave terminalReason=null → the loop re-drives ONCE" (`empty-turn-termination.ts:212-213`), bounded to one. The reported-error requeue path appends no nudge (`reported-adapter-recovery.ts:30-37`) — resumes the same turn from committed state.
- **No max_tokens on tool-call turns** — NOT PRESENT for local endpoints (`LOCAL_DEFAULT_MAX_TOKENS = 16384` on loopback/private baseURL, `openai-http.ts:152-156`; `adapter/types.ts:28`) and Anthropic (`max_tokens` always sent, `anthropic-client/stream-api.ts:38-44,82`); **CONFIRMED for cloud OpenAI-compat**: "cloud endpoints get NO default" (`openai-http.ts:151`). Degenerate-stream guard (tail block ≥ 80 chars ×3, garble ratios) is local-only and guard-stopped streams are never mined for tool calls (`stream-guards.ts:21-35`; `stream-once.ts:50-56`; `openai-compat.ts:193`).

## Findings (two owners / stale claims)

1. Protocol `allowedTools`: `types.ts:85-88` claims session-policy enforcement; only the learned envelope enforces (§4).
2. Wall-clock ownership: `worker-wall-clock.ts` arms every lane, but `tool-failure-summary.ts:22-23` and `verification-submit.ts:75-78` still say interactive-only, and verification keeps a second enforcer (`armVerificationDeadline`, `:251`).
3. `repeat-failure.ts:8` says loop-detection/dead-end are worker-only; the registry and `middlewares/dead-end.ts:5` say all lanes.
4. There is no hard turn cap anywhere: `maxIterations` is a cadence on every lane; the real stops are dry checkpoints, spend, wall clock, and the nudge/pivot ceilings.
5. `protocols/custom.json` stores `steps` as strings, not `ProtocolStep` objects; masked because `body` wins in `protocol_get`.
