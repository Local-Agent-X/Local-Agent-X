# Guard scores: what a run did after a harness guard fired

The turn loop's guards (`src/canonical-loop/middlewares/`, `src/canonical-loop/turn-loop/`) put a message into the model's view or re-open a finished turn. Each firing is recorded. This page is how to see, from recorded runs, what followed each one.

## Run it

```bash
node scripts/score-guards.mjs
```

| Flag | Meaning |
|---|---|
| `--data DIR` | The data folder to read. Default: `$LAX_DATA_DIR`, then `~/.lax`. Read-only. |
| `--session-mode code\|all` | Code sessions only (default) or every session. |
| `--since YYYY-MM-DD` | Only runs created on or after that day. |
| `--json` | The groups as JSON instead of the table. |
| `--detail FILE` | Also write one line per firing (run id, step, task clip) to `FILE`. That is private run data: write it under `reports/`, which git ignores. |

It reads `operations/<op>/canonical-events.jsonl` (the `middleware_fired` events) and `operations/<op>/op-turns/`. It makes no model call.

## Columns

- **Fires / Runs**: firings of that guard, and how many runs they were in.
- **Run ended within 3 steps**: the run had three or fewer steps left after the firing.
- **Next steps changed approach**: one of the next two steps called a tool that the firing step and the step before it had not used.
- **Guard-specific signal**: one check that fits the guard, named in the cell.

These are mechanical signals of what followed. They do not say whether the guard was right; the `--detail` file is for reading individual firings before deciding that.

## First table: code sessions, 2026-11-12

178 firings in 100 runs.

| Guard | Model family | Fires | Runs | Run ended within 3 steps | Next steps changed approach | Guard-specific signal |
|---|---|---:|---:|---:|---:|---|
| premature-completion | claude | 53 | 53 | 100% | 4% |  |
| tool-failure-summary | claude | 40 | 29 | 18% | 68% | 8%: the failed tool later succeeded |
| budget-ladder | claude | 23 | 10 | 13% | 78% | 0%: the stretch before it had produced nothing new |
| external-change-diff | claude | 8 | 4 | 13% | 63% |  |
| external-change-diff | gpt | 8 | 1 | 0% | 38% |  |
| reasoning-only | claude | 8 | 6 | 0% | 88% |  |
| spec-audit | claude | 6 | 6 | 100% | 0% | 0%: the run edited a file afterwards |
| open-steps | local | 5 | 5 | 100% | 0% | 0%: a step-list tool was called afterwards |
| tool-failure-summary | local | 5 | 3 | 20% | 60% | 0%: the failed tool later succeeded |
| budget-ladder | gpt | 3 | 1 | 0% | 100% | 0%: the stretch before it had produced nothing new |
| open-steps | claude | 3 | 3 | 33% | 67% | 33%: a step-list tool was called afterwards |
| post-edit-diagnostics | claude | 3 | 1 | 0% | 100% |  |
| verify-gate | claude | 3 | 2 | 33% | 67% | 0%: a build, type-check or test ran within 3 steps |
| continuation-guard | claude | 2 | 2 | 0% | 100% |  |
| budget-ladder | local | 1 | 1 | 100% | 0% | 0%: the stretch before it had produced nothing new |
| build-verify | claude | 1 | 1 | 100% | 100% | 100%: a build, type-check or test ran within 3 steps |
| dead-end | claude | 1 | 1 | 100% | 100% |  |
| loop-detection | gpt | 1 | 1 | 0% | 0% |  |
| premature-completion | gpt | 1 | 1 | 100% | 0% |  |
| spec-probe | claude | 1 | 1 | 0% | 100% | 100%: the run edited a file afterwards |
| verify-gate | gpt | 1 | 1 | 100% | 0% | 0%: a build, type-check or test ran within 3 steps |
| verify-gate | local | 1 | 1 | 0% | 100% | 0%: a build, type-check or test ran within 3 steps |

## What this table suggests

- **budget-ladder**: none of its 27 firings came on a stretch that had produced nothing new. Since 2026-11-12 a rung reached with new results is silent, so by this signal none of these would fire today.
- **spec-audit**: six firings, each ended the run with no edit after it. These were the audit judging a chat's first message instead of the request; `opRequestText` was fixed on 2026-11-01.
- **premature-completion**: 53 firings in 53 runs, each followed by the run ending and almost never by a change of approach. All are in the review runs a publish starts. It is the first guard to read in the detail file.
- **tool-failure-summary**: the most frequent guard in ordinary runs. The failed tool later succeeded in 8% of firings; in most, the run moved to another tool.
- **open-steps** on local models: five firings, none followed by a step-list call, each within three steps of the end.

Small counts (under about 5) say nothing on their own.
