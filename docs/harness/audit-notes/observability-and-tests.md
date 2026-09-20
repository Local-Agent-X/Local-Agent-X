# Phase 0 audit — observability, tests, evals (brief §2 Q10, Q11)

Read-only. Paths are repo-relative, lines 1-indexed. VERIFIED = read the code; INFERRED = concluded from evidence; UNKNOWN = not established. Nothing was run.

## 1. What is logged today

| Store | Path | Writer | What a record holds |
|---|---|---|---|
| Server log | `~/.lax/logs/server.log` (5 MB rotate → `server.prev.log`) | `src/index.ts:36-41,55-66` console mirror; `src/logger.ts:39-46` (`LAX_LOG_JSON=1` = JSON body) | `[ISO] [ns] msg`; `ERROR`/`WARN` prefixes |
| Op store | `~/.lax/operations/<opId>/` | `src/canonical-loop/schema.ts:5-15` | `operation.json`, `events.jsonl` (redacted, `src/ops/event-log.ts:62`), `canonical-events.jsonl`, `op-turns/<idx>.json`, `op-messages.jsonl` (`store.ts:316-320`), `side-effects/<sha>.json` |
| Turn artifact | `op-turns/<idx>.json` — plain JSON, **not** `.json.gz` (gz only in the polyglot evidence copy) | `src/canonical-loop/turn-commit-store.ts:225-248` | `{schemaVersion, turn, messages, projection}` (`checkpoint.ts:186-203`) |
| Kernel audit | `~/.lax/ari-audit.db` (sqlite, HMAC chain) | `src/server/lifecycle.ts:180`; `packages/arikernel/audit-log/src/store.ts:24-41` | `tool_class, action, tool_call_json, decision_json, result_json, duration_ms, taint_sources, verdict, previous_hash, hash` |
| Side-effect journal | `operations/<opId>/side-effects/<sha256(opId\|toolCallId)>.json` | `src/tool-execution/side-effect-journal.ts:66-69,177` | exactly-once state machine (`prepared/executing/ambiguous/completed`, fingerprint, result) — not a trace |
| Stall profiles | `~/.lax/logs/loop-stall-<ts>.cpuprofile` (+`-prev`) | `src/server/event-loop-sentinel.ts:211-228`; `rolling-stall-profile.ts:62-72` | gated by `LAX_LOOP_SENTINEL_PROFILE_MS` (default 30000) and `LAX_LOOP_SENTINEL_ROLLING` (off) |
| Retry sidecar | `~/.lax/telemetry/retries.jsonl` | `src/retry-telemetry.ts:18-19` | kinds actually emitted: `loop-abort` ×6 sites, `tool-arg-invalid` ×3, `custom` ×1. Declared `context-overflow`, `tool-blocked`, `model-fallback`, `empty-response-fallback` have **zero callers** (grep) |
| Tool usage sidecar | `~/.lax/telemetry/tool-usage.jsonl` | `src/tool-execution/tool-usage-telemetry.ts:20,44` | tool, action, status, durationMs, sessionId — no args, no result |
| Cost ledger | `~/.lax/usage-log.json` | `src/cost-tracker.ts:221,234` ← `canonical-loop/cost-recording.ts:31-62` | per-op token sums |
| Outcome ledger | `~/.lax/op-outcomes.json` | `src/tool-tracker.ts:27,171` ← `turn-loop/record-outcome.ts:44-51` | `category::model → {total, clean, partial, aborted, gaveUpNudged}` |
| Soak canary | `<cwd>/workspace/canonical-loop-soak-<host>.jsonl` | `src/canonical-loop/soak-metrics.ts:40,82` | one row per terminated op (see §3) |
| Security self-audit | none on disk | `src/security/layer/security-audit.ts:1-10` | boot-time posture findings, **not an event log** |

**Server-log events (VERIFIED):** policy denies `src/tool-policy/evaluator.ts:129-133`:
```
`[policy] DENY pack=${pack.id}` + (decision.ruleId ? ` rule=${decision.ruleId}` : "") + ` tool=${call.name} session=${ctx.sessionId} reason=${decision.reason}`,
```
stalls `src/server/event-loop-sentinel.ts:361` (`[loop-sentinel] event loop blocked for ${lagMs}ms …`) and `event-loop-sentinel-worker.ts:354-355`; summarizer failure `src/context-manager/compaction.ts:82` (`[context] LLM compaction call failed`); classifier timeouts/breaker `src/classifiers/classify-with-llm.ts:159,170,278,303`; preflight refusal `src/canonical-loop/adapters/openai-compat/request-preflight.ts:78` (`preflight refused send: …`); prompt sizing `src/canonical-loop/prompt-preflight.ts:92-95` (`[prompt-profile] mode= reason= window= budget= full= top= included= degraded=`); provider/model per turn `src/routes/chat/run-chat-turn/prepare-and-route.ts:43` (`[chat-diag] prepared … provider= model=`). Loop aborts are **not** a server-log line; they go to `retries.jsonl` (`src/agent-guards/loop-detection.ts:162,179,203,254,271`).

**What one turn record contains (VERIFIED).** `turn` = `OpTurnRow` (`src/canonical-loop/types.ts:171-199`): `providerState{adapterName, adapterVersion, providerPayload, viewCompacted}`, `toolCallSummary[]`, `terminalReason`, `modelMs`, `toolDispatchMs`, `nextTurnPivot`. `toolCallSummary` (`types.ts:240-253`) = `tool, argsHash, resultStatus, durationMs, committing` — hash, not args. `providerPayload` for openai-compat (`adapters/openai-compat.ts:268-276,300-306`) = `lastTurnIdx, finalizedMessageId, stopReason, pendingTools, model, usageInputTokens?, usageOutputTokens?`. `messages` = assistant `{text, toolCalls[{name, arguments}]}` (`openai-compat.ts:245-256`) and tool results (`turn-loop/dispatch-tools.ts:170-173`):
```
        role: "tool_result",
        content: { toolCallId: call.toolCallId, result: out.result, status: out.status },
```
So: parsed tool calls with raw argument JSON — yes; tool result text + status + duration — yes; **full prompt as sent — no** (system prompt never hits disk; `operation.json` carries only content-free sizing, `src/ops/types.ts:58-59` "Content-free prompt sizing captured before dispatch and persisted with the op"); **request params — no** (no temperature/num_ctx/tool list/stop sequences in `providerPayload`); **raw response — no** (text is post-scrub `assembledText`); **thinking — no** (`adapters/openai-compat/stream-once.ts:120` streams `reasoning_chunk` live; nothing persists it); **latency** — `modelMs` per turn only, TTFT only per op (`firstContentLatencyMs` in soak); **kernel decisions** — in `ari-audit.db`, not joined to the op.

**Token usage (VERIFIED, load-bearing).** Per-turn usage comes from `stream-once.ts:129-131` ← `src/providers/adapters/openai-http.ts:342` `chunk.usage.prompt_tokens`, which only exists when the request asks for it, and `openai-http.ts:107-112,196` asks only for known cloud baseURLs:
```
// Unknown/local baseURLs (Ollama, custom) run free and some strict
// servers reject the param, so leave them alone.
```
Ollama-native counters (`prompt_eval_count`, `eval_count`, `prompt_eval_duration`, `load_duration`) have zero references in `src/` (grep). Consequence, confirmed in `eval/op-outcomes/results/run-2026-09-18T05-47-19-muse-33392.json`: every muse run has `"inputTokens":0,"outputTokens":0`, while grok runs have real counts. **Local models have no token, cost, or context-overflow measurement today.**

## 2. Replay

**Can a run be replayed step by step?** Partially (INFERRED from the record shapes above). Messages, tool args, results, statuses, and per-turn model/tool time are on disk in order. What is not reconstructible: the prompt the model actually saw for turn N — the system prompt is absent, and the compacted view is ephemeral (`types.ts:42`: "Compaction never persists to op_messages"); `eval/compaction-quality.mjs` exists precisely because the summary a model saw has to be re-generated after the fact.

**Replay/diff tooling today (VERIFIED):**
- `src/replay-test.ts` (`npm run test:replay`, CI `security.yml:154-155`): structural replay of `test/fixtures/recordings/*.json`. That directory **does not exist** (`ls test/fixtures/`), so it logs `[replay] No fixtures dir … nothing to replay` (`replay-test.ts:53`) and passes vacuously.
- `session-repeat` (`src/tool-execution/resolve-tool.ts:106-145,265`) replays an identical tool call's prior result within a session — dedup, not a run replayer. Side-effect journal `replay` is crash-recovery only.
- Evidence readers: `eval/op-outcomes/op-store.mjs` (`readOps, chatModelsIn, opTurnCount, toolResultText, toolCalls`), `eval/rereads.mjs`, `eval/compaction-quality.mjs`, `eval/op-outcomes/report.mjs` (soak + op-outcomes.json aggregator). Untracked `tmp/*.mjs`: `read-prof.mjs` (cpuprofile top-N), `ctx-prof.mjs`/`ctx-block-repro.mjs` (buildTurnContext stage timing), `fts-probe.mjs`, `contam-check.mjs`.
- **No step viewer**: no `/api/ops` route (grep `src/routes`), no consumer of `readOpTurns` in routes/server/chat-ws/desktop other than the writers. **No diff tool.** Runs are keyed by opId, not by a run id; an eval run's link to its ops is the temp data dir.

**Missing vs §3.1:** full prompt per request; params; raw text; thinking; per-request token counts for local models; per-step TTFT/p50/p95; tool exec args (only hash) in the summary row; kernel decision joined to the tool call; run id across ops; replay of the compacted view; diff; viewer.

## 3. Tests

**Counts** (`find`, VERIFIED): `src/**/*.test.ts` 846, `test/**/*.test.ts` 475, `desktop/src` 15, `packages/**/__tests__` 55 → **1,391** files under the `vitest.config.ts:22-27` include; 18 `*.contract.test.ts`.

**How it runs.** `npm run test:unit` = `vitest run` (`package.json:33`); `pool: "forks"`, `isolate`, `maxWorkers = min(6, cpus/4)` (`vitest.config.ts:5,49-56`), 15 s timeout, coverage floors 32/27/32/33 (`:74-79`). No shard script exists in `package.json` or `scripts/` (grep). Local facts (INFERRED from memory `lax-test-suite-run-facts.md`, `project_vitest_gitbash_collection_failure.md`, not reproduced): the monolithic run dies exit-144 inside Claude Code; use `npx vitest run --shard=N/4 --maxWorkers=2`; shard 4 is unrunnable in that harness; Git Bash breaks vitest collection, use PowerShell.

**CI** (`.github/workflows`, VERIFIED): `security.yml:80-88` unit-test matrix ubuntu+windows, Windows `npm run test:unit` blocking (`:127-129`), ubuntu `test:coverage` (`:131-133`), desktop tests, replay; integration job boots a server and runs `src/test-suite.ts`. `pre-flight.yml`: pre-commit audit, `check:generated-docs`, `tsc`, `npm run build`. `evals-scheduled.yml`: **workflow_dispatch only** — nightly cron removed (`:33-38`, GitHub runners cannot hold the xAI stream); every eval step `continue-on-error`. `installer-rolling.yml:583-592` reruns unit+desktop tests.

**Notable contract tests (headers VERIFIED):** `src/context/rule-coverage.test.ts:1-17` (every registry rule still reaches the model across three window profiles; 32k still sheds), `src/context/prompt-degradation.test.ts` (452 lines), `src/harness-rows.contract.test.ts:1-16` (harness rows reach the model, never the user), `src/harness-text.contract.test.ts:1-15` (every marker in the registry is stripped by every scrubber), `test/op-outcomes-checks.test.ts:1-4` (every eval check can fail), `test/canonical-loop-soak-metrics.test.ts:1-9` (soak sink silent under vitest) plus `test/unattended-long-soak-qualification.test.ts` (spawned restart/crash workers).

**`canonical-loop-soak-PMAJLABS.jsonl` at the repo root:** 117 soak rows, `startedAt` 2026-07-25T14:23Z → 2026-09-08T02:53Z (anthropic 89, local 14, xai 9, codex 2); the live canary `workspace/canonical-loop-soak-PMAJLABS.jsonl` (1,230 rows, gitignored) starts 2026-09-08T02:58Z. The writer's path is `join(process.cwd(), "workspace")` (`soak-metrics.ts:38-40`), which cannot produce the root path → INFERRED: the pre-Sep-8 canary was moved out of `workspace/` when it was reset (mtime Sep 7 21:54 local = 02:54Z, its last row). No script references it. `hook-log.txt` beside it is 92 lines of a literal unexpanded `"[hook] File written at $(date +%H:%M:%S)"` — a broken hook echo.

## 4. Evals

**aider-polyglot** (`eval/aider-polyglot/`, VERIFIED): curated 12 (`curated.mjs:4-7`: grade-school, wordy, transpose, phone-number, pig-latin, bowling, poker, grep, dominoes, list-ops, two-bucket, forth). One isolated server per exercise with web tools denied by seeded policy (`run.mjs:75`); two attempts, Aider protocol (`run.mjs:135-141`); verdict `run.mjs:186`:
```
    const result = harness ? "HARNESS" : score.ok ? (contaminated ? "CONTAMINATED" : "PASS") : "FAIL";
```
Scoring = hidden stdlib unittest (`lib.mjs:142`), never the reply; reply only feeds FALSE-DONE via regex `claimsDone/admitsIncomplete` (`eval/grok-coding-parity/lib.mjs:245-252`). Stalls read from `server.log` regex (`run.mjs:101`), turn-floor distress (`run.mjs:124`), `recovered` list from `driveChat` (`grok-coding-parity/lib.mjs:53-54`). Evidence sealed gz to `~/.cache/aider-polyglot-reports/evidence/<stamp>/<slug>/{operations, logs/server.log}` (`run.mjs:232`; `lib.mjs:208`) plus stall profiles; report `pass@1 / pass@2 / false-done` (`run.mjs:304`). Self-checks: `scorer-selfcheck.mjs` (reference solution PASS, stub FAIL-as-model), `detector-selfcheck.mjs` (24 cases for `lookedOutsideWorkspace`, `lib.mjs:246`). `run-cli.mjs` = same exercises through grok CLI / codex exec as a harness-vs-harness control.

**op-outcomes** (`eval/op-outcomes/cases.json`, 16 cases, VERIFIED):

| id | category | checks |
|---|---|---|
| browser-fact | browser | replyIncludes |
| browser-consent-wall | browser | replyIncludes |
| setup-account-not-build | browser | fixtureRequest, toolNotUsed |
| research-to-doc | research | fileIncludes |
| find-project | files | replyIncludes |
| match-original-site | coding | renderedCss ×2 |
| bugfix-with-followup | coding | commandPasses, fileUnchanged |
| deploy-with-secret | secrets | fixtureRequest(header), notInTranscript |
| memory-cross-session | memory | replyIncludes (2 sessions) |
| constraint-survives-long-session | long-session | pathsAbsent, pathsPresent (6 turns) |
| multi-page-site-match | hard | renderedCss ×4, fileIncludes |
| correction-chain | hard | moduleAssert ×5, fileUnchanged |
| rename-with-shell-guard-collision | hard | textAbsent, commandPasses, moduleAssert |
| moved-docs-page / moved-deep-page / moved-page-404-nav | hard | fileIncludes |

Check types in `checks.mjs:119-216`: `replyIncludes, fileIncludes, renderedCss` (headless Chromium `getComputedStyle`, `:25-41`), `commandPasses, fileUnchanged, pathsAbsent, pathsPresent, moduleAssert` (child-node import), `textAbsent, fixtureRequest, toolNotUsed, notInTranscript`, plus an implicit `model` check against silent fallback (`run.mjs:172`). Per run it reports PASS/FAIL/HARNESS-ERROR (`run.mjs:226`) and metrics `rounds, modelMs, toolMs, inputTokens, outputTokens, cacheRead/Write, nudges, compactedRounds, errors` (`run.mjs:83-108`); results to `results/run-<stamp>-<provider>-<pid>.json` (`:212`, gitignored `.gitignore:155`); failing runs keep their temp dirs (`:185`). `baseline.json` floors are warn-only.

**Other rigs:** `tool-discovery` (29 cases, first tool called, live server, pre-commit gate `scripts/eval-gate.mjs`; `threshold.json` says `totalCases: 30` vs 29 in `cases.json`), `instruction-compliance` (4 scenarios, live server, ordered tool trace + fs + git), `grok-coding-parity` (7 fs-scored scenarios, live server), `compaction-fidelity` (8 cases, verbatim retention through the real summarizer, warn-only), `capability-grounding` and `dedup-live` (no LLM, call enforcement code directly), `wave2-soak` (its **own** isolated-server spawner at `$HOME/lax-soak` — a second isolation implementation), `sweep-completeness` (README + hand rubric, no runner), `local-model-bench.mjs`/`routing-judgment.mjs` (direct Ollama microbenches). `tool-discovery`, `instruction-compliance`, `grok-coding-parity`, `compaction-fidelity` all drive the **live** `~/.lax` server (`tool-discovery/run.mjs:34`, `instruction-compliance/lib.mjs:29`, `grok-coding-parity/lib.mjs:22-32`), i.e. the mistake H-002 fixed for the two main rigs.

**LLM judge:** none in scoring (VERIFIED by grep of `judge|llm` across `eval/`: every hit is a comment, a regex, or the summarizer under test).

**Ledger/baseline:** `eval/HARNESS_LEDGER.md` — H-001…H-034 classed HARNESS/MODEL/EVAL, a MODEL-failure table, run 22 (qwen3.6:27b pass@1 4/12, pass@2 11/12 vs muse 2/11, 3/11; Grok 11/12, 12/12), run 23 op-outcomes 14/16 both. `eval/HARNESS_BASELINE.md` — model table (muse ~4,200 prefill / ~76 decode tok/s), every classifier site with budget, timeout inventory, rig timeouts.

**Brief §3.2 categories → today's tasks:**

| Category | Today | Count |
|---|---|---|
| File system | find-project; constraint-survives-long-session (delete .tmp); tool-discovery `files.*` first-tool only | 2 real |
| Shell/system | none dedicated (polyglot runs python incidentally; obligation-commit uses git) | **0** |
| App/browser | browser-fact, consent-wall, setup-account, research-to-doc, match-original-site, multi-page-site-match, moved-docs/deep/404 | 9 |
| Multi-step missions | constraint-survives (6 turns), correction-chain (3), bugfix-with-followup (2), 12 polyglot exercises; no `reference_steps` anywhere | ~15, unreferenced |
| Protocol runs | none | **0** |
| Ambiguity | none — no `expected_question`/`scripted_replies` in `eval/` (grep) | **0** |
| Recovery | moved-* (3, broken links), rename-with-shell-guard-collision, polyglot retry-on-red | 5 |
| Injection resistance | none (deploy-with-secret checks exfil of a secret, not an injected instruction) | **0** |
| Restraint | constraint-survives (don't touch legacy), instruction-compliance prohibition-no-edit; no "refuse destructive without approval" task | 2 partial, 0 destructive |

**§3.3 metrics present today:** task success (pass rate, pass@1/2) — yes; tool-call validity — only `tool-arg-invalid` events in `retries.jsonl`, no rate; fabricated observations — role markers are **scrubbed** (`src/providers/output-sanitize.ts:102-107`), not counted; `fabric` appears nowhere in `soak-metrics.ts`/`tool-tracker.ts`; steps vs reference — rounds/tool counts, no reference; loops — `loop-abort` in `retries.jsonl`, not joined to eval rows (H-032 was counted by hand); stalls — yes; budget exhaustion — `did-not-converge`; cost — `modelMs`/`toolMs`, tokens cloud-only, no p50/p95 step latency, no prompt-processing time; safety — `notInTranscript` secret check only; `injection_executed`/`unsafe_action` undefined; asking behaviour — none.

## 5. Sandbox and fixtures

**Isolated server** (`eval/op-outcomes/isolated.mjs`, VERIFIED): two `mkdtemp` roots `lax-eval-*/data` and `lax-ws-*/workspace` (`:88-90`), credentials read in place via `seedProbeProvider` (`:96`), `settings.json {provider, model, localClassifierModel}`, optional `tool-policy.json`, `security.json` registering only the fixture port (`:112`), free loopback port + random bearer token, spawn of `dist/index.js` with `LAX_DATA_DIR/LAX_WORKSPACE/LAX_PORT/LAX_AUTH_TOKEN`, `LAX_SELF_EDIT_PROBE=1`, caller-sized `LAX_PROBE_MAX_LIFETIME_MS`, `LAX_BROWSER_HEADLESS=1` (`:139`), sentinel profile 4000 ms + rolling (`:145`); 180 s health poll (`:24`); SIGTERM→SIGKILL tree kill; both roots deleted on cleanup; `assertDistMatchesSource` refuses a stale `dist/`. File access stays at the product default (`:105`):
```
  // File access is left at the product default ("unrestricted"), so a run
```
so a model can and does wander the real disk (the LOOKED-OUTSIDE flag). Network: only the polyglot rig denies web tools; op-outcomes does not, so "no live network during eval" is **not** enforced there (UNKNOWN whether any case has reached the internet — the fixture log only records fixture traffic).

**Fixtures:** `fixtures/workspace/{api-client, bellavista-clone, nav-app, notes, pricing-app, projects, research, vistawell-clone}`; `fixtures/server.mjs` loopback HTTP with invented facts and a recorded request log (bridge fact, cookie wall, two-step signup + `/form/submit`, pricing pages, `/site/original`, `/site2/*`, moved docs/handbook/incident pages, `/deploy/v1/deployments` POST); generated `cleanupTree` (`checks.mjs:64-91`); `fixtures/op-outcomes.json` + `canonical-loop-soak-test.jsonl` for `report.mjs`; polyglot uses a bare git clone so no hidden test exists as plain text (`lib.mjs:26-45`).

**Scripted replies:** none. Multi-turn cases are fixed turn lists, never conditional on a question.

**Disposable browser profile:** the agent profile is `join(getLaxDir(), "chrome-profile")` (`src/browser/launcher.ts:20,280`; Playwright twin `:359`), and `getLaxDir()` follows `LAX_DATA_DIR`, so each isolated server gets a fresh profile under its temp data dir and loses it on cleanup — effectively disposable (VERIFIED by path derivation, not executed).
