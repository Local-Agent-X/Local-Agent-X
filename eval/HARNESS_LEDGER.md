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
| H-021 | Periodic 5.7→8.9s event-loop blocks every ~66s in a long op (phone-number, run 16), growing with op length | HARNESS | Unknown: post-stall profiles show only idle time; op-store reads on this op take 17ms | Rolling stall profile (6f80f943) named it: the 30s recovery janitor reconciled the LIVE op, re-projecting every turn artifact synchronously. 48be00d2 skips ops a live worker holds | run 18 |
| H-022 | poker: 56 `recall` calls, stub never edited | HARNESS? | Compaction's omitted/summary block advertises recall cursors; with the summarizer failing (213% of window) the model paged old history back in instead of working | OPEN — judge after H-016 (working summaries) | — |
| H-023 | poker FAIL scored as MODEL despite 15s stalls | EVAL | Stall check ran only for timed-out rows | af06ec24 | — |
| H-024 | grep attempt 1 ended in 13s: the reply was muse's plan ("Let's list workspace."), no tool call | HARNESS | openai-compat surfaced reasoning as the answer on ANY stop, so decide-outcome saw text + end_turn and ended the turn; the reasoning-only re-drive path never engaged (and would have re-driven unbounded with no nudge) | Reasoning surfaces as the answer only on a length stop; a reasoning-only interactive turn gets one nudge to act on its plan, then ends honestly | tests |
| H-016 | Summaries fail; audits/probes return nothing (~75s/op) | HARNESS | Review calls ran on the background model (the 3B pin loops; cloud providers use haiku-class models), and local review calls spent their budget on a thinking pass | Every classifier call declares `role: "review" \| "routing"` (required; tsc enumerates sites). Review runs on the worker's model; Ollama classifier calls send `think:false`; review budgets sized for the worker (constraint 6s, test-deletion 8s, refutation voters 10s). Measured muse idle: ~4.2k tok/s prefill, ~76 tok/s decode | run 17 |

| H-025 | spec-audit answered in budget but both replies were invalid JSON (fails at char ~101) → no verdict | HARNESS | A local model emits almost-JSON (raw newline in a string, trailing comma, smart quote, Python literal); the log named the parse error but never what was sent | One bounded repair pass before the retry (repair-json.ts) + the reply's first 200 chars in the failure message. The snippet then showed the real shape: muse over-escapes quotes around quoted code (`\\"` for `\"`) while naming the exact unmet requirements, so a second candidate un-escapes them | tests |

| H-026 | wordy: the spec audit found 2 unmet requirements and its nudge was REFUSED (shared pool spent on "a tool call failed" notices); op ended 1 failing test short | HARNESS | Flat nudge pool: chatter outbids the guards that speak from evidence (same class as the earlier self-bounded fix) | Verdict-bearing guards (build-verify, spec-probe, spec-audit, regression-audit, design-verify) get a bounded pool of their own, then queue for the shared one | tests |

| H-027 | bowling passed and was scored CONTAMINATED | EVAL | The detector's drive rewrite was anchored at the string start, so a WSL-style path ("/mnt/c/...") to the model's OWN workspace, written mid-command, never matched the root | Normalize each extracted path on its own; self-check 17 cases | re-scored PASS |

| H-028 | grep (run 19): every read/write/glob failed as `missing required field "path"`; the model reported its tools broken and stopped, stub untouched | HARNESS | muse emitted the argument object with its chat template leaking into the KEY (`read<\|message\|><atem:parameter name="path`), value intact. arg-repair handled malformed JSON and wrong types, not corrupted names | `repairMarkerKeys` recovers the property when a marker key ends with a schema name that is still missing; narrow by construction, logged as a repair | tests; run 20. Also ended list-ops (run 19) outright: read blocked 5x → repeat-failure abort at 95s |

| H-029 | Compaction replaced ~8,900 tokens of real work with the single word NOTHING_NOTABLE | HARNESS | That is the prompt's escape hatch for a GENUINELY EMPTY stretch; muse used it for 56 messages of file reads, test runs and its own failure analysis, and nothing checked it. Explains the 10–35x re-reads of the same file in compacted ops | Reject it when the segment carries work (tool calls/results or long answers): one retry with feedback, then null so the caller keeps the longest fitting tail instead. Verified live: the same history now summarizes in 9.4s to a 971-char digest naming the added()/booleans mismatch and the outstanding asks | tests + live replay |

| H-030 | A small local model was auto-selected for routing whenever one happened to be installed | HARNESS | Routing was justified by CONSEQUENCE ("a wrong answer cannot block the work"), never by accuracy. Measured: llama3.2:3b 3/8 vs muse 7/8 — it saved a one-off command as a durable fact, dropped "stop asking before you run the tests", kept an unrelated memory as on-topic, and emitted two JSON objects for one verdict | Nothing is auto-selected: a pin wins (and is routed to the runtime that certified it), otherwise routing runs on the chat model. Cost is bounded because routing is conditional — follow-up verdict only on 3-12 word messages, relevance only when session signals exist, memory write fire-and-forget | tests |

## Documented MODEL failures (muse-glimmer:30b)

| Exercise | Run | Reason (evidence) |
|----------|-----|-------------------|
| grade-school | 14 | `added()` returns names; retry answered "already verified" without editing |
| grade-school | 15 | `roster()` returns a dict grouped by grade |
| grade-school | 19 | Wrote the solution 7x and ran its own checks, but `added()` returns the student names where the tests expect [True, True] (3 failures, 7 errors); retry ended on loop detection while hunting the hidden tests. Harness clean: 0 stalls, spec audit MET, regression verdict delivered |
| grade-school | 18 | 189 tools, one write (not the stub): searched for the hidden tests for 36min across both attempts, never implemented. Harness clean: zero stalls, no summarizer/classifier failures |
| grade-school | 16 | 70 turns searching for the hidden tests; never edited the stub |
| wordy | 19 | 2 failures on the swapped ValueError messages. The retry showed the exact diff ('unknown operation' != 'syntax error') and it did not swap them; Grok passes wordy pass@1. Harness clean: 0 stalls, spec audit MET, regression clean |
| wordy | 18 | One failing test: "syntax error" vs "unknown operation" — but the spec audit had found it and could not nudge (H-026), so re-run after that fix |
| wordy | 15, 16 | swaps "syntax error" / "unknown operation"; retry explains instead of fixing |
| transpose | 19 | Keeps trailing spaces the suite forbids (3 failures), 22 tools. Harness clean: 0 stalls, regression verdicts delivered; one spec-audit empty response on the retry (gate no-op, watching) |
| transpose | 16 | Drops the leading padding transposed rows need |
| phone-number | 19 | Wrong ValueError messages ("Invalid NANP phone number" vs the required texts): 13 failures, 3 errors. Harness clean: 0 stalls; the spec audit had named the exact strings but its JSON was over-escaped (H-025 second candidate) |
| dominoes | 19 | Retry spent the full 30min without converging (171 tools), tests red. Harness healthy: 0 stalls, no arg failures, spec audit delivered "2 unmet items". Also tried to read a PREVIOUS run's workspace path (already deleted — nothing leaked) |
| bowling | 16 | Turns 42–86: no edits; re-read files and re-ran its own two failing checks until loop detection ended it |
| forth | 13 | re-read five files ~20 times without editing; ran bare `python` |
