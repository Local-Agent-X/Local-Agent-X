# Harness ledger — local models

One entry per issue. Classification: HARNESS (fix), MODEL (document), EVAL (fix the rig,
with justification). Mission: `docs/agent-prompts/local-model-harness.md`.

| ID | Symptom | Class | Root cause | Fix | Result |
|----|---------|-------|------------|-----|--------|
| H-001 | Every polyglot row scored FAIL regardless of code | EVAL | Scorer ran `python3`, the Windows Store stub | `resolvePython()` + `scorer-selfcheck.mjs` | self-check 12/12 |
| H-002 | Eval wrote false facts into the user's memory | EVAL | Rig drove the user's live server | One isolated server per exercise (`eval/op-outcomes/isolated.mjs`) | no writes to `~/.lax` |
| H-003 | 126s model turn mid-exercise | HARNESS | skill-review started a model call during a running turn (idle check only saw session saves) | 010512c1: running foreground op counts as busy | no background op in later runs |
| H-004 | Event loop blocked 5→19s per turn on long ops | HARNESS | History rebuild re-scanned every earlier turn per turn (cubic) | fc93e361: one incremental accepted-message scan | 600-turn rebuild 7.2s → <3s test |
| H-005 | Model re-read files and got "Unchanged since…" with no content, repeatedly | HARNESS | Read-dedup trusted session read-state, not the model's (compacted/seeded) view | c3bf5597: stub only when a real read is in view; model-view.ts | test pins both cases |
| H-006 | Model walked into the server's own data dir | EVAL | Data dir sat beside the workspace | 51e5f233: separate temp roots | — |
| H-007 | Model read the hidden tests from `~/.cache` | EVAL | Benchmark was a plain checkout; evidence/reports plain text | 007e0e2d: bare clone via `git show`, gzipped evidence, LOOKED-OUTSIDE-WORKSPACE flag | disk search finds nothing |
| H-008 | Four real passes marked CONTAMINATED | EVAL | Detector boundary was the workspace dir, not the exercise's temp root | 942791be | detector self-check 14/14 |
| H-009 | 11s event-loop block during a glob of `C:\` | HARNESS | glob bounded matches not breadth; fast-glob chained matching without yielding | 06ff145a: MAX_DIRS 20k + setImmediate per readdir | glob of home dir 443ms, no stall |
| H-010 | `read /tmp/...` → "File not found" | HARNESS | Git Bash `/tmp` not mapped by the shared resolver | 73adbcdd | test |
| H-011 | Over-window send refused, forced retry | HARNESS | Open summarizer breaker skipped compaction even past critical | 8c659125 | test |
| H-012 | Row showed fatal `context_overflow_compacting` though the turn finished | EVAL | driveChat recorded recoverable notices as the error | a5a7bc32: `recovered` list | — |
| H-013 | Model saw only its last 2–3 tool calls; re-read loop → loop-detection abort | HARNESS | Elision without a summary kept the keep-tier tail (4–6 msgs) | b16c805e: longest tail that fits | test |
| H-014 | Every retry: "user asked you not to run shell commands" | HARNESS | Ledger confirm (3B background model) returned `shell` for "don't try and change them" | c0a63ff4: confirmed class must be supported by a cue | test |
| H-015 | Re-read got a replayed dedup stub | HARNESS | Session-repeat replay reused a no-content stub | aa19d9c8 | test |
| H-017 | (latent) server self-destructs during a slow retry | EVAL | Isolated servers lived 45 min; polyglot allows two 30-min drives, op-outcomes several turns + idle wait | Callers size `maxLifetimeMs` from their worst case | — |
| H-018 | Classifier calls on a 30B model return null; breaker then pauses all classifiers 60s | HARNESS | 1.5–3s budgets (constraint-extract, curate, confirm-gate, followup, test-deletion) cannot fit a 30B prefill | OPEN — budgets from measured throughput (Phase 1) | — |
| H-019 | A timed-out background call keeps the GPU busy | HARNESS | Classifier race and tool backstop abandon the work without aborting it | OPEN | — |
| H-020 | Compaction can block ~60s, not 30s | HARNESS | Budget is per attempt × guardedRewrite's 2 attempts | OPEN (Phase 1) | — |
| H-021 | Periodic 5.7→8.9s event-loop blocks every ~66s in a long op (phone-number, run 16), growing with op length | HARNESS | Unknown: post-stall profiles show only idle time; op-store reads on this op take 17ms | Diagnostics: rolling CPU profile covering the stall (LAX_LOOP_SENTINEL_ROLLING, on in eval servers); root cause OPEN | — |
| H-016 | Summaries fail; audits/probes return nothing (~75s/op) | HARNESS | Review calls run on the pinned 3B model (loops) or on muse with budgets not sized for it | OPEN — Phase 2 review/routing split | — |

## Documented MODEL failures (muse-glimmer:30b)

| Exercise | Run | Reason (evidence) |
|----------|-----|-------------------|
| grade-school | 14 | `added()` returns names; retry answered "already verified" without editing |
| grade-school | 15 | `roster()` returns a dict grouped by grade |
| grade-school | 16 | 70 turns searching for the hidden tests; never edited the stub |
| wordy | 15, 16 | swaps "syntax error" / "unknown operation"; retry explains instead of fixing |
| forth | 13 | re-read five files ~20 times without editing; ran bare `python` |
