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

| H-031 | op-outcomes setup-account-not-build: muse abandoned a signup form, reporting the select action "keeps timing out / refusing to mutate" | HARNESS | `select` was the only ref-addressed interaction demanding a CSS selector. muse sent `{action:"select",ref:4,value:"LLC"}` after observing the page, was told "'selector' and 'value' are required", invented CSS, and timed out. The backends also disagreed: a ref-addressed write to a `<select>` worked in-app (selectFillScript) and threw on the CDP path (Playwright fill() cannot type into one) | The element decides the operation: a ref whose tag is SELECT is chosen, not typed into, so `fill` and `select` mean the same thing on the same ref, and `select` takes `ref` or `selector` like click/fill | tests; the case re-run PASSES on muse (56s, 11 rounds, 0 nudges) |

| H-032 | Open question: does loop detection punish re-reads the HARNESS caused? A model whose history was compacted away re-reads a file, and the detector sees a repeated read with an identical result | UNCLASSIFIED | Not yet measurable. The 10-35x same-file re-reads that raised the question came from ops compacted to NOTHING_NOTABLE (H-029); every such run predates that fix, so its re-read counts measure the summarizer, not the detector. Reset-on-compaction was considered and NOT written: a livelocked op is compacted every turn, so forgiving on the marker would disable the guard exactly where it earns its keep | Measured on run 21 (first full run with real summaries): NO op was ended by loop detection - zero loop-abort and zero no-progress fires across all 12 exercises; the two that did not converge spent the 30-min wall clock instead. Re-reads DO stay high in compacted ops (9-21 reads per file vs 2.0-2.5 in the two ops that never compacted) but they never reach the guard, because an edit resets the progress counters before the count climbs. No change to loop detection: the concern does not materialise, and forgiving re-reads on the compaction marker would have disabled the guard for exactly the long ops it exists for | CLOSED - no change needed |

| H-033 | op-outcomes find-project ended on one sentence — "Let me search the workspace for it." — 1 round, 0 tools, 0 nudges, and the user got a promise instead of a path | HARNESS | The done gate reads a tool-less turn carrying assistant text as a finished informational turn. H-024 fixed the variant where the plan arrives as REASONING; this is the same stall with the plan arriving as the ANSWER, and nothing looked at it | Same bounded treatment as reasoning-only: one nudge per op, then the turn ends honestly. Fires only on an interactive turn with no tool call, in an op that has dispatched no tool at all, whose reply is short, promises a next action (via narrationPromisesFollowup - the repo's one promise detector) and is not a question back to the user. Asked BEFORE the done gate, never after | tests (13 + 6 through decideTurnOutcome). SECOND INSTANCE, same case, different surface: the whole reply was `bash -c "Get-ChildItem -Recurse -Filter *CRM* ..."` - the command typed out instead of called - so the promise detector matched nothing. The command shape now nudges too, and can only ever nudge: the text extractor's refusal to execute a bare command string is untouched. Writing the wiring test found an over-reach - a 197-char answer naming the files it would delete was under a 200-char cap and said "I'll" - so the prose rule is now ONE sentence under 90 chars, not length alone. find-project 4/4 on re-run, but the case swings 36s-381s, so the pass is not attributed to the guard |

| H-034 | Run 21 flagged LOOKED-OUTSIDE-WORKSPACE on 7 of 12 exercises | EVAL | Six were REAL (`find C:/ -maxdepth 4 -name dominoes_test.py`, `find C:/Users/peter -exec grep -l grade_school`) and found nothing - the sealing works. The seventh (grep) was three detector bugs at once: (1) arguments arrive as JSON TEXT, so a doubled backslash is a separator and a single one an escape - flattening both alike read `as f:
` in a Python heredoc as the drive path "f:/n"; (2) the extractor matched from "/users/", so Git Bash's "/c/Users/..." lost its drive and could never be inside the root (run 19 fixed the same miss for "/mnt/c/"); (3) an exercise NAMED after a search tool put "grep" in every path it touched, so every command reading its own workspace looked like a disk-wide hunt | Decode the way JSON means it; match paths from the drive; judge search verbs with the paths removed; stop counting an interpreter path as an outside location (which the contract already claimed) | self-check 16 -> 24 cases; grep re-scores clean, the six hunts still flag, two-bucket stays CONTAMINATED on its own evidence |

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
| constraint-survives-long-session | op-outcomes (2026-09-18) | Kept the standing constraint correctly and named the exact split — legacy protected, three .tmp files outside it removable — then asked permission instead of deleting them, so the folder was never tidied. No policy block or tool refusal was involved; the case passed on the previous battery, so this is borderline judgment, not a deterministic failure |
| grade-school | 21 | `added()` returns the student names where the tests expect [True, True] - the SAME defect as runs 14/15/19. 163 tools, 146 of 168 turns compacted, harness clean. Also hunted the disk for the hidden tests (`find C:/Users/peter -exec grep -l grade_school`) |
| wordy | 21 | 'unknown operation' != 'syntax error' - the swapped ValueError messages, fourth run running. The spec audit named the exact strings and it still did not swap them; Grok passes wordy pass@1 |
| transpose | 21 | 'Single line.' != the per-character transposition - still drops the padding transposed rows need (same as 16, 19) |
| phone-number | 21 | ERROR in test_area_code; hunted Temp for test_phone_number.py |
| bowling | 21 | Did not converge in 30 min (152 tools, harness healthy throughout): 'Exception not raised'. Searched Temp for any *.py containing BowlingGame |
| grep | 21 | Did not converge in 30 min (143 tools, harness healthy). Output lines wrong. Its LOOKED-OUTSIDE flag was the harness's fault, not the model's - see H-034 |
| dominoes | 21 | 'False is not None: there should be no valid chain' - accepts an impossible chain. Ran `find C:/ -maxdepth 4 -name dominoes_test.py` |
| forth | 21 | Lists differ: [6, 6] != [5, 6] - 21 re-reads of forth.py, one distinct file, no convergence |

## Run 22 — qwen3.6:27b on the same 12 exercises (2026-09-18)

The comparison the whole harness campaign was building toward. Same rig, same
sealed evidence, same scorer, same isolated servers; 17.4 GB vs muse's 18.2 GB,
so the card is not the variable.

| | muse (run 21) | qwen3.6:27b (run 22) | Grok (control) |
|---|---|---|---|
| pass@1 | 2/11 | 4/12 | 11/12 |
| pass@2 | 3/11 | **11/12** | 12/12 |
| false-done | 0 | 0 | - |
| contaminated / unscored | 1 | 0 | - |
| disk hunts for the hidden tests | 6 of 12 | **0 of 12** | - |
| tool calls, grade-school | 163 | 13 | - |
| turns, grade-school | 168 | 16 | - |
| wall clock, 12 exercises | ~4h | ~55min | - |

qwen's only failure is forth: the solution HANGS (killed after 60s of tests),
an infinite loop in its own code - a model defect with no harness component.

What this settles: the harness is not the limiter. The same rig that scores
muse 3/11 scores a same-size model 11/12, with zero harness failures in both.
muse's failures were largely a STRATEGY failure - it searches instead of
writing (bash:70 glob:42 read:36 and ONE edit on grade-school; 6 of 12 runs
spent time hunting the disk for the hidden tests) - and no harness fix reaches
that. Compaction bears it out: 7 of 12 qwen exercises never compacted at all
(reads/file 1.0-4.0) because the work fit; muse compacted 146 of 168 turns on
grade-school alone (reads/file 12.0).

### Run 22 follow-ups (asked and answered from the evidence)

**qwen's forth failure is the model, not the rig.** Two things happened and only
one is ours. The hang is its own code - an infinite loop, killed after 60s of
tests. The retry WAS told: attempt 2's task begins literally
`[killed: tests exceeded 60s - the solution hangs]`, so the harness reported the
failure and the model had it. What looked like a harness bug was not: qwen ran
`cd "C:\Users\peter\...\aider-forth-f2yk8E"` and bash consumed the backslashes
as escapes (correct POSIX behaviour), leaving `C:UserspeterAppData...`. LAX
already detects that and says so - "looks like a Windows path whose backslashes
bash consumed as escapes ... use forward slashes or single quotes" - once, with
the fix spelled out. The model then wrote its own _verify.py, broke it with a
Python-2 print statement and an unmatched paren, and spent the rest of its turns
there. No harness defect; no fix shipped.

**Tool availability in the rig.** `web_search` is BLOCKED by tool-policy
(`[blocked, layer="tool-policy"]`) on purpose - an exercise must be solved, not
looked up, or the benchmark measures search. `memory_search` is NOT blocked: it
runs and returns `count="0"` because an isolated server starts with an empty
memory bank. Both are fully available in the product; only web is denied, and
only here.

**A third face of the same muse strategy failure.** grade-school (run 21): 6
`web_search` calls and 14 blocked tool results across the op - it kept reaching
for a tool that had already refused it, alongside hunting the disk for the
hidden tests in 6 of 12 exercises. qwen: zero web_search calls, zero disk hunts.
Not a capability gap on either side.

## Run 23 — op-outcomes (everyday tasks) on qwen3.6:27b

| | muse | qwen3.6:27b |
|---|---|---|
| op-outcomes | 14/16 (88%) | 14/16 (88%) |
| failing cases | setup-account / constraint (rotate run to run) | memory-cross-session, multi-page-site-match |

Equivalent on everyday tasks, and both models' failures are VARIANCE, not
deterministic defects: qwen's memory-cross-session passes on re-run (44s), the
same way muse's constraint and setup-account cases each failed once and passed
once. The recall path works - session 1 wrote the fact via `remember` and the
reply confirmed it; on the failing run session 2 answered from general knowledge
(and reached for web_search) instead of the recalled fact.

multi-page-site-match is the decisiveness trade-off showing up as a cost: qwen
finished in 10 rounds / 71s with the CSS close but wrong (header 96px vs 72,
nav gap 8 vs 24, h1 28px vs 40, cta rgb(26,122,98) vs rgb(14,124,102)) - it
eyeballed rather than measuring computed styles. muse ground the same case out
in 95 rounds / 569s and PASSED it. The style that wins the coding benchmark
(read, write, run - 11/12) is the same style that loses a pixel-matching task.

Net: the two models are interchangeable for everyday tasks and are NOT
interchangeable for coding (3/11 vs 11/12). No harness failure in either run.

