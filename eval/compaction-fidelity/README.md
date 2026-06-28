# compaction-fidelity eval

Measures whether the harness's **real** context compaction preserves load-bearing
facts when it summarizes old turns. Compaction runs every turn during long
sessions ([`compactIfNeededWithLLM`](../../src/context-manager/compaction.ts)); if
its LLM summary silently drops a constraint, a user fact, or a decision, the
agent regresses mid-task with no signal. This eval is that signal.

## How it works

Each case in [`cases.json`](./cases.json) states a **distinctive, unparaphrasable
fact** (a codename, amount, ID, or version string) early in a transcript. The
runner buries it under filler turns so it lands in the **summarized head** (not
the verbatim tail), forces compaction via `POST /api/eval/compact` (a thin
pass-through to the canonical function), and checks how many facts survive
verbatim in the compacted output.

- **Metric — retention:** fraction of seeded facts that appear verbatim in the
  summary. It is a **conservative fidelity floor** — a fact paraphrased rather
  than kept verbatim scores as a miss, so true fidelity is *at least* the number
  shown.
- **NO-LLM cases:** if compaction fell back to deterministic truncation
  (`summarizedByLLM=false`, e.g. `LAX_LLM_COMPACTION=0` or the provider was
  unreachable), the case is **excluded** from the score — truncation drops the
  head wholesale, which isn't a summarization-fidelity signal.
- **Non-deterministic → warn-only:** the summary is LLM-generated, so the runner
  prints a ⚠️ when a category falls below its [`baseline.json`](./baseline.json)
  floor but **always exits 0**. It never gates a commit.

## Run

Requires the dev build running (`npm run dev`) with the desktop app quit (it owns
port 7007). The summary routes through your configured provider's background
model, so it spends a small number of tokens per case.

```
npm run eval:compaction
node eval/compaction-fidelity/run.mjs --only constraints --filler 30
```

`--only <id-substring|category>` filters cases; `--filler <n>` sets how many
innocuous turns bury the fact (default 24).

## Updating the baseline

After a clean local run, copy the observed per-category retention into
`baseline.json`'s `lastBaseline.observed` and, if the bar genuinely moved, raise
the floors. Don't lower a floor to silence a real regression.

## Not wired into CI

Like the op-outcomes battery, this is **local-first**. CI runners can't hold the
streaming connection to the xAI endpoint (every call premature-closes), and the
summary path depends on a configured provider, so a scheduled run would just burn
tokens producing empty reports. Run it locally before shipping compaction
changes.
