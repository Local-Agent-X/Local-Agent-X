# Harness Mechanisms Campaign — Wave 2 Ledger

Goal: ship C1 (anchor+estimate token counting), B2 (compaction circuit breaker),
E9 (read dedup + external-change diffs), D2 (end-of-turn extraction coalescing)
as independent, verified, committed-to-main chunks. Never push.

Spec: docs/harness-mechanisms-backlog.md (commit 48d31714). Rules: no AI
fingerprints in commits, files <400 LOC, verify with `npm run build` (includes
codebase-map freshness — run `npm run docs:map` after adding files), tests
mandatory, no new parallel files where a canonical owner exists.

## Done-list
- [ ] C1: compaction + status context-size figures are anchored to last real API
      usage (input + cache-read + cache-creation + output) plus estimate of
      messages appended since; anchor-walk handles multi-record assistant turns
      (shared message id) and skips synthetic messages; regression tests.
- [ ] B2: 3 consecutive failed compaction attempts in a session → stop
      attempting for the rest of session + clear surfaced error state; counter
      resets on success; tests.
- [ ] E9: per-file read state (content, mtime, range, partial flag) in bounded
      LRU extending language-intel file-state layer; unchanged re-read → stub;
      external modification → per-turn diff-snippet attachment; evict only on
      file-gone; partial views never dedup; tests.
- [ ] D2: end-of-turn-write.ts wired into live persistTurn path with cursor +
      in-progress flag + stash-one-trailing coalescer; skip-and-advance when
      main agent wrote memory since cursor; shutdown drain; tests.
- [ ] Integration gate: full `npm run build` green + existing suite green +
      cross-seam checks.

## Out of scope
- A1 perfect-fork / cache_control (Wave 3, gated).
- B1 layered compaction, B4/B7 (Wave 3).
- D2's fork-jailing/pre-injected manifest parts that depend on A1 fork
  machinery — Wave 2 ships coalescing + wiring on the existing extraction call
  path only.
- C2 file-type-aware ratios (separate backlog item).

### C1/B2 (complete)
- Spec's "compact-history.ts" = src/canonical-loop/turn-loop/compact-history.ts
  (canonical per-turn compactor: toChatParams :25, safeSplitIndex :69,
  compactHistory :76; keepLast ladder 6/4/2; null summary → keep FULL history).
  Trigger: build-input.ts:37 inside buildTurnInput(op, turnIdx, ...) after
  collapseAdjacentUserMessages(:80)/prependDigestToLastUser(:101).
- src/context-manager/: token-estimation.ts (estimateTokens chars/3.5 :6,
  messageTokens :10, totalTokens :37), status.ts getContextStatus :15
  (thresholds 60/75/90 anthro, 25/35/55 codex; forceCompact at critical),
  compaction.ts (policy module; summarizeOldMessages :132 shared summarizer,
  30s timeout, LAX_LLM_COMPACTION env), model-windows.ts, overflow-detection.ts
  (isContextOverflowError UNWIRED — known ledgered defect, out of scope).
- NO retry/attempt counter exists anywhere in compaction (B2 = greenfield state).
- Real usage: per op_turn row (opId, turnIdx) providerState.providerPayload
  {usageInputTokens, usageOutputTokens, cacheReadTokens, cacheCreateTokens};
  written by adapters (anthropic.ts:198 etc.), persisted via checkpoint.ts
  insertOpTurn; aggregated by op-usage.ts aggregateOpUsage(:29) — readers:
  cost-recording, soak-metrics, checkpoint(:211), worker(:230). Compaction
  threshold currently runs on ESTIMATE ONLY — the drift C1 fixes.
- Message shape: CanonicalMessage {messageId, role, content, turnIdx?,
  seqInTurn?}; roles system|user|assistant|tool_result|control. Parallel tool
  calls = ONE assistant row (content.toolCalls array) + SEPARATE tool_result
  rows each with own msg-<uuid> id + seqInTurn; tool-only turns finalize NO
  assistant row → anchor by turnIdx, not message id. Ordering key =
  (turnIdx, seqInTurn). Synthetic ids: compact-summary-* (ephemeral, no disk
  row), nudge-*, um-*-init-*, open-steps-warn-*, etc.
- estimateTokens also feeds src/context/usage.ts (parallel estimator w/ own
  thresholds) + memory/cognitive compressor — formula unchanged in C1, so no
  blast there. totalTokens sole external consumer = status.ts.
- checkAndCompact/checkAndCompactAsync in execute-tool.ts = dead shims (no
  runtime callers). emitContextStatus (prepare-and-route.ts:45) emits
  context_status event off getContextStatus(cleanHistory).
- Tests: compact-history.test.ts (mocks getContextStatus+summarizeOldMessages;
  u/a/tr helpers), compaction.test.ts; NO tests exist for token-estimation.ts
  or status.ts (C1 adds them).

## Chunks (footprints locked)

| id | chunk | footprint | status | commit |
|----|-------|-----------|--------|--------|
| C1 | anchor+estimate token counting | footprint + stream-api.ts + adapter-contract/types (viewCompacted era stamp) + turn-loop.ts | GREEN after 2 fix rounds (final skeptic HOLDS: 0/5269 store rows wrongly accepted; 3/3 mutations caught) — ON MAIN | 2b80112a |
| B2 | compaction circuit breaker | compact-history.ts (breaker :131-197, 294L total) + build-input.ts:42 + 6 tests | GREEN (skeptic HOLDS, 3/3 mutations caught) — ON MAIN | 50540c62 |
| E9 | read dedup + external diffs | read-state.ts, run-sandboxed.ts, read-write-tools.ts, new external-change-diff.ts (order 247), registry.ts | GREEN (skeptic HOLDS + hardening round: mutation gap closed w/ catch-proof, redaction leak fixed w/ failing-before test) — ON MAIN | 7dc910f7 |
| D2 | extraction coalescing | new src/memory/extraction-coalescer.ts (166L), write-safely.ts (write clock), manager.ts, lifecycle.ts, curate-nudge.ts (+13L getter, justified deviation) | GREEN (skeptic HOLDS, 4/4 mutations caught) — ON MAIN | 6e967906 |

## Schedule
- Wave A (parallel, worktrees): C1, E9, D2 — footprints disjoint (verified).
- Pipeline: B2 starts when C1 lands (conflict edge: compact-history.ts).
- Merge: each chunk = ONE commit in its worktree; orchestrator cherry-picks
  onto main (linear history, no branches on main per Peter's rule). Never push.
- Approval: Wave 2 shape pre-authorized in Wave 1 planning (memory) + explicit
  user command "run Wave 2" = the one human gate. Proceeding.

## Recon facts (load-bearing)

### D2 (complete)
- end-of-turn-write.ts: runEndOfTurnMemoryWrite(:73) ZERO prod callers; stateless
  single-shot classifier→USER.md write via classifyWithLLM(category
  "end-of-turn-write", LAX_MEMORY_END_OF_TURN, 8s timeout); trigger gate
  documented (:16-18) but unimplemented; fire-and-forget contract (:65-72).
- Live path: canonical-run.ts persistTurnState(:156) → manager.ts persistTurn(:199
  call to autoExtractAndSave, awaited); exactly-once per turn via salvage()
  (:59/:114) + salvaged bool; stale-writer guard isCurrentTurnWriter (:164-168)
  runs BEFORE persist; `done` emitted :110 before salvage :114.
- NO extraction cursor exists anywhere. Closest pattern to copy:
  operational-ingest.ts watermark file (watermarkPath :41, IngestState.lastTs).
- Mutual exclusion choke point: src/memory/write-safely.ts (writeMemorySafely :87,
  appendToDailyLogSafely :151, runMemoryGate :171); MemoryWriteSource enum
  (:44-49) distinguishes "tool" vs "eot"/"auto-extract"; no write-clock today —
  add per-path last-write marker there (or tap snapshotBeforeOverwrite :129 /
  memory.markDirty()).
- Shutdown: registerShutdown in src/server/lifecycle.ts:236, shutdown() :247;
  drain flush must be awaited BEFORE memoryIndex.close() (:267). SV-2 invariant:
  only lifecycle.ts may process.exit (lifecycle.test.ts enforces).
- Gotchas: double-extraction if both auto-extract + end-of-turn-write fire per
  turn without shared cursor; markdown writes are read-modify-overwrite races;
  coalescer deferring past turn-return escapes turn-lock — must respect
  generation check; tests mock persistTurn with vi.fn(async()=>{}).
- Test patterns: end-of-turn-write.test.ts (mocks writeMemorySafely +
  classifyWithLLM, temp dir), auto-extract.test.ts, turn-lock-timeout.test.ts.

### E9 (complete)
- CANONICAL read-state layer = src/tools/read-state.ts (NOT ts-project.ts, NOT a
  new context-manager file). Per-session Map<sessionId, Map<canonPath, sha1>>
  (:21); keys via realpathDeep (:39); API recordFileSeen(:57),
  checkFreshness(:71) → "ok"|"stale"|"unseen", forgetSessionReads(:78).
  Unbounded (no LRU). Deliberately hash-not-mtime (:12-15, atomic-save races).
- Enforcement seam: src/tool-execution/run-sandboxed.ts — FRESHNESS_GUARDED
  {edit,edit_lines,multi_edit} (:30), RECORDS_SEEN {read,write,edit,edit_lines,
  multi_edit} (:32), pre-execute block :60-79, recordFileSeen on success :342.
  Tools themselves do NOT record — hooks live at this phase layer.
- Read tool: src/tools/read-write-tools.ts readTool(:34); forceFullRead when
  <1000 lines (offset/limit IGNORED, :85-90) — "partial" only meaningful ≥1000
  lines. Envelope: ok(content, meta) via result-helpers.ts; do NOT add a 6th
  status (parseStatusHeader regex + status-keyed middleware blast radius) —
  unchanged stub = ok(stub, {unchanged:true,...}).
- Diff-attachment channel: canonical-loop middleware sibling of
  post-edit-diagnostics.ts (returns {kind:"nudge"} from afterToolExecution;
  registered registry.ts:184 order 245; per-op state via getMiddlewareState
  cleared on op-terminal). NOT context/builder.ts system-prompt sections.
- ts-project.ts: leaf under language-intel facade, TS-welded (ts.IScriptSnapshot);
  only ts-provider.ts imports it. Mirror its evictOverCap LRU pattern (:229),
  don't literally reuse. Keys resolve() not realpathDeep — known divergence.
- Diff baseline: content captured AT READ TIME is "before", disk is "after"
  (post-edit-diagnostics.ts:8-17 — baseline unknowable at middleware time).
- MEMORY.md correction: context-manager has NO builder.ts; prompt builder is
  src/context/builder.ts (harnessNotice wrapper). context-manager contents:
  compaction*.ts, index.ts, model-windows.ts, overflow-detection.ts, status.ts,
  token-estimation.ts.
- Tests: read-state.test.ts (unseen→ok→stale, junction equivalence),
  run-sandboxed.test.ts (gate e2e), file-tools.test.ts, language-intel.test.ts.

## Decisions (engineering, made)
- E9 seam: EXTEND src/tools/read-state.ts (canonical read-state owner) + new
  canonical-loop middleware for external-change diff nudges; spec's "new
  src/context-manager/file-read-state.ts" rejected — context-manager is the
  compaction subsystem and read-state.ts already owns this responsibility
  (canonical-check). ts-project.ts stays untouched except pattern-mirroring.
- E9 store gains: content snapshot (for diffs), mtime prefilter, range/partial
  flag, bounded LRU eviction (evict only on file-gone per spec + size cap),
  while keeping sha1 semantics for unchanged detection.

## Parked for Peter
- D2 policy flags (shipped with conservative defaults, revisit if desired):
  (a) gate = existing curate signals only (regex boosts, classifier teach
  conf≥0.6, fired cadence nudge) → ~≤20% of turns, est <$0.01/day; (b) the
  `remember` facts tool does NOT count as "agent already curated" (one-line
  change if you want facts saves to suppress the profile pass); (c) shutdown
  drain budget = 3s.
- E9 product flags: (a) stub wording is model/user-visible ("Unchanged since
  this session last read it … pass an explicit offset (e.g. offset=1)");
  (b) external-change nudges fire on ALL lanes incl. interactive chat (caps:
  5 files/nudge, 40 diff lines/file) — heavy editor autosave will consume
  turns; (c) re-read right after harness's own write/edit now returns a stub
  (changes verify-read-after-edit output shape).
- C1 coverage flags: (a) anchored sizing covers API-key HTTP turns + tool-less
  CLI turns only; tool-heavy CLI turns fall back to pure estimate (CLI result
  frame proven run-cumulative from ~/.lax/operations evidence — widening needs
  per-iteration usage capture: priority call); (b) follow-up chunk:
  stream-cli/stream-parse.ts:188-194 debug block's removal condition now
  satisfied (soak evidence exists), file was out of C1 scope.
- B2 policy flags: (a) 500-op bound can evict a TRIPPED breaker under extreme
  op churn (re-enables attempts) — add "never evict tripped" if wanted;
  (b) no cool-down: a transient 90s provider outage across 3 turns trips for
  the op's remaining life (spec said "rest of session"; a cool-down is a
  product call); (c) skeptic note: unconfigured-provider nulls also trip
  (spec-compliant, stops pointless work) but the error text slightly
  misdescribes that case — cosmetic follow-up.

## Soak findings (pass 1, tag soak2-mrbj7e16, 32 ops, provider routed to
## anthropic/claude-opus-4-8 despite settings=codex — task-class routing)
- E9 LIVE-VERIFIED: 5 external-change nudges (2+2+1 across churn sessions),
  3 unchanged-stubs, stubs at reread-after-adoption = correct baseline
  semantics. Cost model confirmed (once per turn, not per call).
- C1 LIVE: anchor engaged 21/34 usage turns (62%); 13 refusals all
  observedTools (tool-bearing CLI turns, by design); 0 stamp/cache/adapter
  refusals. Conversation estimate = 0.1-2% of real request size.
- B2: silent all soak (0 trips, 0 recoveries) — correct (no summarizer
  failures).
- FINDING (HIGH, product): chat baseline ≈147k tokens BEFORE first message
  (wp-gate tools=73 manifest + system + memory) on a 200k-effective window.
  One big paste → raw "Prompt is too long" op death at t1 (op c6ed855f).
- FINDING (HIGH, config): model-windows.ts says opus-4-8 = 1M (true for API
  per claude-api reference) but CLI/OAuth Max path serves ~200k effective →
  ALL thresholds (60/75/90) computed vs 1M → compaction can never fire on
  Peter's daily path; C1 plausibility clamp also 5x too generous there.
  Fix = transport-aware effective window. RECOMMENDED NEXT CHUNK.
- FINDING (MED, architecture): each chat message = new op → C1 per-op anchor
  can't carry across session turns; session-level anchoring (previous op's
  usage feeding emitContextStatus + session compaction) = Wave 3 candidate,
  possibly ahead of A1 in value.
- FINDING (HIGH, root-caused): D2 never fired because ALL classifiers are
  dead when settings provider is uncredentialed: chat reroutes codex→anthropic
  (resolve-provider.ts) but resolveProviderContext (classifier seam,
  resolve-provider-context.ts:58) resolves the RAW settings value, returns
  null, classifyWithLLM bails at classify-with-llm.ts:110 in 1ms (112
  auth.resolve errors in soak log). Gate/coalescer worked perfectly (probe
  proved run executed). Compounding bugs: (a) runEndOfTurnMemoryWrite consumes
  the curate signal at :79 BEFORE availability known + coalescer advances
  cursor on null = signal destroyed on unavailability; (b) silent-null stack —
  4 seams return null unlogged, a no-op run emits ZERO lines; (c) stage-2
  teach-moment classifier equally dead (bare catch{} at
  prepare-request/curate-nudge.ts:83). Test gap: no test covers config class
  "selected provider ≠ credentialed provider"; every test stubs the classifier.
  Fix direction: classifier seam reuses chat's reroute; unavailable ≠ success
  (no signal consume, no cursor advance); one debug line per null seam.
- Battery lesson: synthetic word-salad filler trips Claude AUP refusals
  (3/4 anchor sessions died at t0) — use natural prose in soak prompts.

## Fix-round chunks (post-soak)
- de2214d6 classifier reroute + honest unavailability: skeptic HOLDS (4/4
  mutations killed; credentialed path byte-identical; transient-blip guarded —
  presence-probe false is the only reroute trigger). Low findings: codex
  fallback corner w/ config-level OpenAI key (flagged); chain order pinned
  only by NEW test (chat's own suite blind to it); double auth warn in
  no-creds state (cosmetic); env-kill now preserves signal (arguably correct).
- LIVE VERIFY at de2214d6: reroute fired ("classifier context rerouted to
  'anthropic'"), classifier MADE A REAL CALL — then parse failed: model wraps
  JSON in ```json fences, parseWriteDecision expects raw JSON. One more masked
  layer. Micro-fix chunk dispatched (canonical fence-strip helper).

## Failed / abandoned
(none yet)

## Skeptic verdicts
- D2 @4b66ba16: HOLDS. Attacked concurrency interleavings (PoC race harness),
  cursor tick boundaries, gate degeneration, eviction, shutdown drain vs 8s
  classifier, persistTurn byte-parity; 4/4 mutations caught. Residual (all
  bounded to one extra/skipped run): first-signal-turn mutex bypass (cursor
  inits to current tick), over-broad "tool" tick (memory_save/.bak suppress one
  pass), throw-retry near-theoretical (classifyWithLLM swallows to null).
  Non-blocking nit: move trailing-pending check into .finally. LANDED main
  @6e967906 (codebase-map regenerated + amended in).
- E9 @2d772f38: HOLDS core property (hash always decides when mtime matches;
  sweep miss backstopped by checkFreshness at edit gate; afterToolExecution =
  once per TURN not per call → cost fine; registry pure append). 2 hardening
  items sent back: (1) uncaught mutation — hash-check removal survives suite
  (invariant test missing: same-mtime content change); (2) redacted reads
  snapshot REAL bytes → misleading stub + potential secret-bearing diff hunks
  in nudge channel (redaction bypass) — must record hash-only/never-dedup.
  Also flagged intentional relaxation: full-diff adoption lets edits proceed
  from a 40-line lossless diff (old_string-match backstop) vs old hard block.
  Stray untracked zz-skeptic-repro.test.ts (pre-existing) moved out by skeptic.
- C1 @a2e8bd6d (round 2): BROKEN, one surviving finding — observedTools gate
  refuted by store audit: 41% (56/138) of anchor-eligible rows physically
  impossible (>200k window, max 3.03M; observedTools recording only began
  2026-06-26 so absence ≠ clean; doc-comment evidence misquoted). Held: stamp
  choke point, cache-field capture, adapter gate; 4/4 mutations caught.
  Round-2 fix dispatched: explicit boolean viewCompacted era stamp on EVERY
  commit (absence → refuse; kills the 41% + pre-deploy transitional nit),
  plausibility clamp (contextTokens > lookupContextWindow(model) → refuse),
  corrected citations, honest residual doc (sub-window cumulative anchors once
  then self-limits).
- C1 @78b2ec67 (round 1): BROKEN. (1) HIGH stale anchor post-compaction — compaction is
  ephemeral, next replay = full history but anchor usage = compacted sent view
  → undercount → over-window send (op death) or compact/resend oscillation;
  compact-summary-* guard is dead code cross-turn. (2) MOD stream-api.ts (HTTP
  path) drops cache_read/cache_creation from done-event usage → systematic
  undercount (only CLI stream-parse.ts:249 forwards them). (3) WATCH CLI-proxy
  result-frame usage semantics unverified (may be run-cumulative across
  in-stream iterations → overcount). Held: 1:1 toChatParams mapping, no double
  count, straddle unreachable, byte-identical old exports, tests real (3/3
  mutations caught). Fix round dispatched to implementer.
