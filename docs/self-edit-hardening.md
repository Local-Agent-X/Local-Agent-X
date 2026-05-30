# self_edit hardening — plan + status

Goal: a `self_edit` (the in-app agent rewriting LAX's own source) must never be
able to brick the running app. The sandbox isolates *source* but historically
leaked through *dependencies*, *probe state*, *shallow gates*, and
*un-revalidated merges*. This tracks the full hardening pass.

Origin: an 11-issue audit of the self_edit path. Issue #1 in that audit (the
junction-teardown traversal fix) shipped before this pass. The remaining 10 are
tracked below as two passes.

## Gate order (current, after Pass 2)

```
fingerprint-parent-deps → spawnClaude → verify-parent-deps(restore+abort if mutated)
  → deps → build → bind → smoke → security-scope(HOLD if security/auth/policy touched)
  → merge → re-gate(rebuild merged main) → record(boot-pending)
  → [next boot] confirmMergeBoot on bind / revertPendingMergeIfCrashed on crash
```

Both the sandbox path and the bypass path acquire the same machine-wide global
lock before touching the shared tree (Pass 2, #9); the lock is atomic and the
`_unsafe` rescue can force-steal it (Pass 3, #4).

Key files:
- `src/self-edit-sandbox.ts` — orchestrates the gate flow + merge + re-gate
- `src/self-edit-sandbox-gates.ts` — gateDeps / gateBuild / gateBind / gateSmoke
- `src/self-edit-smoke-suite.ts` — broad endpoint assertions for the smoke gate
- `src/self-edit-rollback.ts` — merge record + revertLastMerge + boot notice + unsafe-edit snapshot
- `src/self-edit/global-lock.ts` — machine-wide PID-file lock shared by sandbox + bypass (#9)
- `src/agency/worktree.ts` — junctions, isolateNodeModules, security-scope matcher, orphan sweep, git/build primitives
- `src/self-edit/tool.ts` — entrypoint; sandbox vs bypass (_cwd / _unsafe) routing; bypass lock + unsafe snapshot
- `src/self-edit/bypass-runner.ts` — bypass path (no gates)
- `src/autopilot/validate.ts` + `loop.ts` — autopilot's own per-round validation
- `src/autopilot/boot-proof.ts` — end-of-shift bind+smoke boot proof for the run summary (#3)
- `src/startup-integrity.ts` — boot integrity check + warn-only probe mode

## Pass 1 — SHIPPED (issues #1-dep, #2, #4, #5, #6, #8, partial #7)

- **Deps isolation (lazy hybrid)** — `gateDeps` (gate 0). If the worktree diff
  touches `package.json`/`package-lock.json`, drop the shared `node_modules`
  junction (`isolateNodeModules`) and run a real isolated `npm ci`; a failing
  install blocks the merge. No dep change → junction stays (fast path). The
  subprocess is instructed (in `prompt.ts`) NOT to run installs itself.
- **Probe hardening** — `gateBind` boots the probe against a disposable
  `LAX_DATA_DIR` (mkdtemp) with the parent token via `LAX_AUTH_TOKEN`; real
  SQLite/memory/secrets untouched. Integrity downgraded from full skip
  (`LAX_SKIP_INTEGRITY`) to logged warning (`LAX_INTEGRITY_WARN_ONLY`). Temp
  dir removed in the sandbox `finally`.
- **Smoke depth** — after the chat ping, `runSmokeAssertions` requires
  `/api/health`, `/api/tools/stats`, `/api/sessions` to each return 200.
- **Merge re-gate + rollback** — capture pre-merge base SHA, rebuild the merged
  main tree, auto-revert the merge if that build fails. Persist
  `{preSha,postSha,baseBranch,repoRoot,files,ts}` to
  `~/.lax/last-self-edit-merge.json`; `revertLastMerge()` is the manual hatch;
  `surfaceUnacknowledgedMerge()` logs a one-time boot notice.

Tests: `test/worktree-deps.test.ts`, `test/self-edit-rollback.test.ts`.
Verified: `npm run build` clean; both new suites green.

## Pass 2 — SHIPPED (issues #9, #3, #10, #11)

- **Chunk 5 — Bypass safety (#9 + #3).**
  - *#9 shared-deps race:* extracted the machine-wide PID-file lock out of
    `self-edit-sandbox.ts` into `src/self-edit/global-lock.ts` (one source of
    truth). The bypass path (`tool.ts`) now acquires it too, so an autopilot
    (`_cwd`) self_edit and a chat `_unsafe` self_edit can no longer build into
    the shared `node_modules` concurrently.
  - *#3 autopilot boot proof:* `src/autopilot/boot-proof.ts` runs a bind+smoke
    pass once at end-of-shift (reusing `gateBind`/`gateSmoke`) when the run
    ended naturally and ≥1 round committed; the verdict is threaded into the
    run summary (`summary.ts` renders a `Boot proof:` line). Autopilot still
    never auto-merges to main — this is a human-merge signal. `_unsafe` stays
    gateless but now logs loudly + snapshots the pre-edit SHA (`recordUnsafeEdit`).
- **Chunk 6 — Security diff-scope gate (#10).** `securitySensitiveChangedFiles`
  (worktree.ts) + a hold in `self-edit-sandbox.ts` before `mergeWorktree`: if
  the worktree diff touches `src/security/**`, `src/tool-policy/**`,
  `src/auth/**`, or `config/protected-files.json`, the merge is HELD
  (`heldForReview`), the branch preserved, and the result prints the exact
  `git diff`/`git merge` commands for a human.
- **Chunk 7 — Orphan junction boot sweep (#11).** `sweepOrphanWorktreeJunctions`
  (worktree.ts) unlinks junctions in every `%TEMP%/lax-worktrees/*` orphan,
  removes the now-safe dir, then `git worktree prune` — wired into
  `src/index.ts` boot (best-effort).

Tests: `test/worktree-deps.test.ts` (+4 for `securitySensitiveChangedFiles`),
`test/self-edit-rollback.test.ts`. Verified: `npm run build` clean; both
suites green (12 tests). Shipped on branch `chore/self-edit-hardening-pass2`.

## Pass 3 — SHIPPED (the deferred residuals + sweep/lock hardening)

- **#1 — Broken-boot auto-revert (the runtime half).** The post-merge re-gate
  only proved the merged tree builds, not boots. Added a boot-success marker:
  `recordMerge` starts boot-pending; the server `listen` callback calls
  `confirmMergeBoot()` on bind; at boot `revertPendingMergeIfCrashed()` (in
  `index.ts`, before `startServer`) auto-reverts + rebuilds a merge that a prior
  boot loaded but never confirmed. Good merges cost 0 extra boots; a broken
  merge self-heals after one failed boot. Limit: import-time crashes can still
  precede the guard — the re-gate build is the first defense.
- **#2 — Mid-run parent corruption.** `src/self-edit/parent-deps-guard.ts`
  fingerprints the parent `node_modules` (count + .package-lock.json/typescript/
  @arikernel/@esbuild sentinels) before the subprocess and after; on mismatch it
  restores via `npm ci` and aborts. Enforces "parent node_modules unchanged
  across the run."
- **#3 — Orphan sweep robustness.** `sweepOrphanWorktreeJunctions` now unlinks
  EVERY shallow reparse point (`scanReparsePoints` + `unlinkReparsePoint`), not
  just hardcoded node_modules, and refuses the recursive delete if any remains.
- **#4 — Global lock.** Atomic exclusive create (`wx`) closes the check-then-
  write race; `_unsafe` rescue can force-steal a live lock; release is
  ownership-aware.

Tests: `self-edit-rollback` (+ boot-marker), `self-edit-global-lock`,
`self-edit-parent-deps`, `worktree-deps`, `protected-files` — 35 green.

### Accepted / out-of-scope (not brick vectors)
- **Fail-open intent/scope gates** — deliberate: better to allow an occasional
  misroute than block legit self_edits when the classifier is flaky. Left as-is.
- **Exfiltration** — a `bypassPermissions` subprocess can read secrets + bash
  out. Real, but the feature's security ceiling, not a brick — tracked as a
  separate security effort, not self-edit-hardening.
- **Probe-port collision (#7-minor)** — autopilot boot-proof probe doesn't take
  the global lock; a port clash yields a false boot-proof failure (cosmetic, no
  brick). Deferred.
