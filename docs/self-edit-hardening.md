# self_edit hardening — plan + status

Goal: a `self_edit` (the in-app agent rewriting LAX's own source) must never be
able to brick the running app. The sandbox isolates *source* but historically
leaked through *dependencies*, *probe state*, *shallow gates*, and
*un-revalidated merges*. This tracks the full hardening pass.

Origin: an 11-issue audit of the self_edit path. Issue #1 in that audit (the
junction-teardown traversal fix) shipped before this pass. The remaining 10 are
tracked below as two passes.

## Gate order (current, after Pass 1)

```
spawnClaude → deps → build → bind → smoke → merge → re-gate(rebuild merged main) → record
```

Key files:
- `src/self-edit-sandbox.ts` — orchestrates the gate flow + merge + re-gate
- `src/self-edit-sandbox-gates.ts` — gateDeps / gateBuild / gateBind / gateSmoke
- `src/self-edit-smoke-suite.ts` — broad endpoint assertions for the smoke gate
- `src/self-edit-rollback.ts` — merge record + revertLastMerge + boot notice
- `src/agency/worktree.ts` — junctions, isolateNodeModules, git/build primitives
- `src/self-edit/tool.ts` — entrypoint; sandbox vs bypass (_cwd / _unsafe) routing
- `src/self-edit/bypass-runner.ts` — bypass path (no gates)
- `src/autopilot/validate.ts` + `loop.ts` — autopilot's own per-round validation
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

## Pass 2 — TODO (instructions for the next session)

Run via `/brownfield`. Read each seam before planning; verify each chunk with
`npm run build` + grep + diff read; one chunk in flight at a time.

### Chunk 5 — Bypass safety (#3 + #9)
- **#9 shared-deps race:** the bypass path (`tool.ts` → `runSelfEditBypass`)
  skips the global sandbox lock that `runSelfEditInSandbox` acquires
  (`self-edit-sandbox.ts` `acquireLock`). A chat `_unsafe` self_edit and an
  autopilot self_edit can build into the shared `node_modules` concurrently.
  → Make the bypass path acquire the same global lock.
- **#3 autopilot has no boot proof:** `autopilot/validate.ts` runs build + size
  (+ opt test) per round but never bind/smoke. Note: autopilot commits to its
  OWN branch and the human merges (`summary.ts` prints the `git merge` command)
  — it does NOT auto-merge to main, so this is a human-merge signal, not a
  brick vector. → Run bind+smoke once at end-of-shift so the summary carries a
  real boot signal. Keep `_unsafe` gateless (deliberate escape hatch) but log
  loudly + snapshot the pre-edit SHA for rollback.

### Chunk 6 — Security diff-scope gate (#10)
- The subprocess runs `claude -p --permission-mode bypassPermissions` and can
  rewrite `src/security/**`, `src/tool-policy/**`, `src/auth/**`,
  `config/protected-files.json`. Gates don't care — it still builds/boots/chats.
  → In `self-edit-sandbox.ts`, before `mergeWorktree`: if the worktree diff
  (`getWorktreeChangedFiles`) touches those paths, block auto-merge, preserve
  the branch, require explicit human confirm.

### Chunk 7 — Orphan junction boot sweep (#11)
- A self_edit that crashes between worktree-create and cleanup leaves a live
  `node_modules` junction in `%TEMP%/lax-worktrees/*`. A later
  `git worktree prune` / AV sweep / manual temp cleanup can traverse it into
  the parent's real deps.
  → Boot-time sweep of `%TEMP%/lax-worktrees` that unlinks stale junctions
  (reuse the `unlinkSharedJunctions` logic) BEFORE `git worktree prune`. Wire
  into `src/index.ts` boot.

### Deferred residuals (lower priority, fold into Pass 2 or later)
- **Mid-run parent corruption (Chunk 1 residual):** if the subprocess disobeys
  the prompt and runs `npm install` anyway, it hits the parent through the
  junction before `gateDeps` detection. Real fix = snapshot parent
  `node_modules` (or the 3 arikernel sentinels + lock hash) before the
  subprocess runs and restore if mutated. Pairs naturally with the rollback
  machinery in `self-edit-rollback.ts`.
- **Broken-boot auto-revert (#7 runtime half):** `startServer(config)` in
  `index.ts:208` is fire-and-forget with no ready signal, so there's no clean
  "did the post-merge boot succeed?" hook. Implement a boot-success marker:
  set the merge record "pending" on `recordMerge`, clear it once the server
  confirms it bound, and on the next boot offer/auto `revertLastMerge()` if a
  prior record is still pending (i.e. the last boot crashed). Needs a ready
  callback threaded out of `server/index.ts` (protected code — touch with care).
