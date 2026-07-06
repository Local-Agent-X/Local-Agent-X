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
| `wire-format` | hidden literal coupling (messy-repo tier) | delimiter change lands in ALL 3 modules that duplicate the literal (runtime round-trip oracle) + stale test UPDATED not gutted + stale doc fixed + the visual `" \| "` keep-path survives |
| `rounding-policy` | duplicated inline logic + stale tests encode the OLD spec | half-up rounding lands at every money site incl. two inline `Math.floor` duplicates (runtime oracle); both stale tests updated to the new spec, meaningful, green; doc fixed; pagination floor (non-money) untouched |
| `column-shift` | positional/index coupling on a mid-row insert | `role` column inserted between name/email; positional reader, magic-index `[2]` consumer, and string-built audit producer ALL agree (runtime oracle); stale test + doc updated |

The messy-repo tier (`wire-format`, `rounding-policy`, `column-shift`) is scored
primarily by **runtime oracles** written after the run — tsc certifies almost
nothing there by design. Their tests are **vitest-native** (the runner LAX's own
build-verify test gate detects and runs), so "tests green" means what the gate
means, and the scenario genuinely exercises that gate end-to-end. Each of the
three ships a `reference` solution overlay, and
`node eval/grok-coding-parity/selftest.mjs` is the scorer's own regression test:
it asserts the model-facing toolchain runs from the project (the win32 rig fix),
that unsolved scores red (never vacuous), and that the reference scores green
(never unwinnable) — the column-shift reference deliberately includes a
legacy-compat superset solution so a brittle old-fixture grep can't creep back
and false-fail correct work. Run it after touching any of their checks.

Scoring lesson baked in (2026-07-06): do NOT grep for the "old fixture" string
to prove a test was updated. A stale assertion of the OLD behavior goes red
against the new code (vitest catches it) and code contorted to keep an old test
fails the oracle — so oracle-green + vitest-green already prove the update, while
a text grep only adds a false-positive against a valid legacy-input test.

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

### Messy-repo tier (2026-07-06)

`grok-4.3`, faithful vitest rig, ×2 each: **wire-format 2/2, rounding-policy 2/2,
column-shift 2/2** — all honest. The harder cross-cutting classes did NOT surface
a grok *capability* gap; what they surfaced were two rig/scorer faithfulness
defects that had been masquerading as model failures:

1. **win32 toolchain (rig):** the per-package tsx junction didn't resolve tsx's
   own deps from the throwaway project, so the model literally could not run the
   tests it was told to keep green (`ERR_MODULE_NOT_FOUND: 'tsx'`) and got scored
   as if it shipped a red test on purpose. Fixed: a single `node_modules`
   junction to the repo's — the model's `npm test` / `tsc` now work in-project.
   `rmSync` unlinks the junction without following it (verified); regression-
   guarded in `selftest.mjs`.
2. **old-fixture grep (scorer):** a brittle "the old fixture string must be gone"
   check false-failed a *correct* solution that kept the old row as an INPUT to a
   new legacy-compat test (grok added `fromCsvRow("7,Ada,ada@x.io") → role
   "member"`). Removed across all three scenarios in favor of oracle-green +
   vitest-green; the column-shift reference now encodes that superset so it can't
   regress.

**Spec-audit gate (`LAX_SPEC_AUDIT`) FP/catch, same runs:** fired on 7 ops, **5
MET / 2 UNMET**, 0 no-verdict. Both UNMET nudges flagged the *literal* prompt
boilerplate **"Use absolute paths"** — the model had used absolute paths for tool
file-paths but written idiomatic *relative import* statements, and the auditor
read the relative imports as the unmet item. The actual deliverables were
complete, and the nudge pushed the model to rewrite imports as hardcoded
`file:///C:/…` specifiers (worse code). So on this suite the gate's FP rate is
**not ≈0** (2/7 firings were complete-work nudges over an ambiguous process
instruction). **Recommendation: keep the gate nudge-only; do NOT wire label
demotion** — demotion would have downgraded 2 complete, correct runs. The
ambiguous "Use absolute paths" boilerplate has since been clarified to name tool
file-paths (imports stay relative), removing the confound for future runs.

`results-*.json` are run artifacts (git-ignored).
