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
| H-018 | Classifier calls on a 30B model return null; breaker then pauses all classifiers 60s | HARNESS | 1.5–3s budgets cannot fit a 30B prompt | Review sites re-budgeted with H-016; routing sites stay on the small model where 2–3s fits | run 17 |
| H-019 | A timed-out background call keeps the GPU busy | HARNESS | Classifier race and tool backstop abandon the work without aborting it | OPEN | — |
| H-020 | Compaction can block ~60s, not 30s | HARNESS | Budget is per attempt × guardedRewrite's 2 attempts | OPEN (Phase 1) | — |
| H-021 | Periodic 5.7→8.9s event-loop blocks every ~66s in a long op (phone-number, run 16), growing with op length | HARNESS | Unknown: post-stall profiles show only idle time; op-store reads on this op take 17ms | Diagnostics: rolling CPU profile covering the stall (LAX_LOOP_SENTINEL_ROLLING, on in eval servers); root cause OPEN | — |
| H-022 | poker: 56 `recall` calls, stub never edited | HARNESS? | Compaction's omitted/summary block advertises recall cursors; with the summarizer failing (213% of window) the model paged old history back in instead of working | OPEN — judge after H-016 (working summaries) | — |
| H-023 | poker FAIL scored as MODEL despite 15s stalls | EVAL | Stall check ran only for timed-out rows | af06ec24 | — |
| H-024 | grep attempt 1 ended in 13s: the reply was muse's plan ("Let's list workspace."), no tool call | HARNESS | openai-compat surfaced reasoning as the answer on ANY stop, so decide-outcome saw text + end_turn and ended the turn; the reasoning-only re-drive path never engaged (and would have re-driven unbounded with no nudge) | Reasoning surfaces as the answer only on a length stop; a reasoning-only interactive turn gets one nudge to act on its plan, then ends honestly | tests |
| H-016 | Summaries fail; audits/probes return nothing (~75s/op) | HARNESS | Review calls ran on the background model (the 3B pin loops; cloud providers use haiku-class models), and local review calls spent their budget on a thinking pass | Every classifier call declares `role: "review" \| "routing"` (required; tsc enumerates sites). Review runs on the worker's model; Ollama classifier calls send `think:false`; review budgets sized for the worker (constraint 6s, test-deletion 8s, refutation voters 10s). Measured muse idle: ~4.2k tok/s prefill, ~76 tok/s decode | run 17 |

## Documented MODEL failures (muse-glimmer:30b)

| Exercise | Run | Reason (evidence) |
|----------|-----|-------------------|
| grade-school | 14 | `added()` returns names; retry answered "already verified" without editing |
| grade-school | 15 | `roster()` returns a dict grouped by grade |
| grade-school | 16 | 70 turns searching for the hidden tests; never edited the stub |
| wordy | 15, 16 | swaps "syntax error" / "unknown operation"; retry explains instead of fixing |
| bowling | 16 | Turns 42–86: no edits; re-read files and re-ran its own two failing checks until loop detection ended it |
| forth | 13 | re-read five files ~20 times without editing; ran bare `python` |
