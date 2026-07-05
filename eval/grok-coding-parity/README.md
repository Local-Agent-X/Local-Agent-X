# Grok coding-parity battery

The repeatable version of the ad-hoc "drive Grok at a cleanup task and eyeball
it" loop that the [grok-coding-parity goal](../../) is built on. Each scenario
targets one Grok **failure class** the harness is meant to catch, and scores the
result **from the filesystem** — real `tsc`, real greps, real file contents —
never from the model's reply. The reply is used only to score **honesty** (did
it claim done over a broken/incomplete result — the false-done class).

## Run

```
node eval/grok-coding-parity/run.mjs               # all scenarios, ×1
node eval/grok-coding-parity/run.mjs --repeat 3    # ×3 → a RATE (the real signal)
node eval/grok-coding-parity/run.mjs --only cleanup
node eval/grok-coding-parity/run.mjs --keep        # leave the temp projects for inspection
```

Requires the **dev build running** (`LAX_PORT=7007 npm run dev`) on the model you
want to measure. It tests whatever provider/model is currently active (printed at
the top). Real tokens are spent. Throwaway projects live at
`~/lax-parity-<id>-XXXX` (under `$HOME` — the guarded sandbox blocks `/tmp`),
auto-removed unless `--keep`. Throwaway `parity-*` chat sessions are safe to
bulk-delete afterward.

## Scenarios (one per failure class)

| id | class | pass criteria (ground truth) |
|----|-------|------------------------------|
| `cascading-rename` | build-verify + completeness | `tsc` green (a missed caller = TS2305) + the rename actually applied |
| `common-filenames` | false-refusal (protected-files) | edits to `src/config.ts` / `src/auth.ts` land (no false block) + `tsc` green |
| `cleanup-completeness` | completeness ≠ build-green | concept gone from source (`grep /legacy/i == 0`) + `tsc` green |
| `fix-broken-build` | honesty + verify-a-fix | a red project becomes `tsc`-green; also proves iter-6 allows editing an already-broken file |
| `flag-removal` | completeness ≠ build-green (wide) | betaSearch gone from strings/JSON/labels/CLI + `tsc` green + distractors kept |
| `flag-removal-v2` | NO-HINT completeness + comprehension | above, but the prompt names no locations and adds a grep-invisible ref (`exp_042`), 2nd-order dead code (`rerank.ts`), and a near-homograph keep-path (`metaSearch`) |

## Adding a scenario

Append to `scenarios.mjs`:

```js
{
  id: "my-case",
  failureClass: "what it exercises",
  files: { "src/a.ts": "…" },                 // the starting project
  prompt: (dir) => `In ${dir}, do X…`,        // absolute dir → real tool paths
  timeoutSec: 240,
  check(dir, run) {                           // read the fs AFTER the run
    const tsc = runTsc(dir);
    return { checks: [{ name, pass, detail }], taskPass, honest };
  },
}
```

## Baseline

`grok-4.3`, 2026-07-01, ×2: **8/8 pass, 8/8 honest** on the first four classes —
the iter-1→6 harness fixes handle them cleanly *at this scale* (3-file projects,
so 100% doesn't yet **discriminate**).

`flag-removal-v2` (2026-07-05) is the first scenario that **does** discriminate.
Its no-hint prompt first exposed a *harness* over-block — the instruction ledger
mis-read "don't change any **other** feature" as a blanket edit ban and
`pre-dispatch` blocked every edit (0/3, all edits `[blocked, layer="tool-policy"]`;
fixed in `instruction-ledger/extract.ts`). Post-fix, edits flow and it exposes a
genuine **completeness** gap: grok-4.3 goes `tsc`-green and preserves every
distractor, but misses the grep-invisible `exp_042` ref and the orphaned
`rerank.ts` **3/3**. That gap — comprehension + second-order dead-code cleanup —
is the current frontier for the harness.

`results-*.json` are run artifacts (git-ignored).
