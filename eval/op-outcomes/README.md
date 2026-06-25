# op-outcomes battery

The Phase-B instrument: a controlled A/B of how the big-3 models handle real
tasks — especially **browser obstructions** (the failure mode where a model
punts a consent banner / overlay back to the user instead of clearing it).

It drives `cases.json` against a **running dev server** via `/api/chat` with real
tool execution, scores give-up vs success directly from each reply, snapshots
the `~/.lax/op-outcomes.json` delta, and prints a per-provider comparison.

## Why it scores the reply, not just op-outcomes

A browser give-up with no task ledger records as `clean` in the telemetry (the
known blind spot). So the trustworthy signal is **give-up detection on the
assistant text** (`GIVEUP_RE` in `run.mjs`). The op-outcomes delta is shown
alongside as a cross-check, not the primary score.

## Before running

1. **Quit the Local Agent X app** — it owns port 7007 and the `~/.lax` store; two
   servers there is split-brain.
2. Start the dev build (has the telemetry code): `npm run dev`
3. Edit `providers.json` — set the exact model ids for `claude` and `openai`
   (open the app's Settings → Model and copy them). `grok` is pre-filled.

This opens **real browser windows** and **spends real tokens**. Run while away
from the machine. The runner restores your original provider/model when done.

## Run

```bash
node eval/op-outcomes/run.mjs --all --repeat 3        # big 3, 3 runs/case → give-up RATE
node eval/op-outcomes/run.mjs --provider openai --repeat 5
node eval/op-outcomes/run.mjs --only browser --repeat 5  # focus the obstruction cases
node eval/op-outcomes/run.mjs --skip-intrusive        # skip computer-control cases
node eval/op-outcomes/run.mjs --timeout 180000        # per-case timeout (ms)
```

`--repeat N` runs each case N times — consent/overlay walls are
non-deterministic, so a single pass/fail is a coin flip; the signal is the
give-up *rate* over N. Default 1.

**Fallback guard:** before each batch the runner drives one probe op and reads
the telemetry tag to confirm the flip actually routed to the target model. If
the provider isn't authed the runtime *silently falls back* to another model
(and both the model's self-report and `GET /api/settings` will lie about it) —
the guard catches that and **skips the batch with a warning** instead of
recording a mislabeled duplicate. This is exactly the bug that made an earlier
"OpenAI" run secretly Grok.

Verdicts: `PASS` (no give-up + expected/substantive answer), `GAVE-UP` (punted
the obstruction), `MISS` (finished but wrong/empty answer), `ERR` (HTTP/timeout).

Full per-case results are written to `results-<timestamp>.json`. The run leaves
throwaway `lax-bench-*` sessions in the sidebar — safe to bulk-delete.

## Caveats

- A battery is only as representative as `cases.json` — it's weighted toward the
  obstruction failure mode on purpose, not a random sample of real usage.
- Give-up detection is heuristic. Eyeball the snippets / `results-*.json` before
  treating a give-up rate as ground truth.
- `--all` flips the live model between batches via `POST /api/settings`; if a
  flip fails (wrong model id), that provider is skipped with a warning.
