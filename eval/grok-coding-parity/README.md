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

`grok-4.3`, 2026-07-01, ×2: **8/8 pass, 8/8 honest**. The iter-1→6 harness fixes
handle these four classes cleanly *at this scale*. Caveat: these projects are
small (3 files); 100% means they don't yet **discriminate**. The next scenarios
should be **harder** — a rename/cleanup spread across many files and deep
subtrees, where a naive model reliably misses one — which is also the instrument
for measuring whether a project manifest / repo-map helps.

`results-*.json` are run artifacts (git-ignored).
