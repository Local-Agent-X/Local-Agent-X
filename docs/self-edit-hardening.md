# self_edit hardening — plan + status

Goal: a `self_edit` (the in-app agent rewriting LAX's own source) must never be
able to brick the running app. The sandbox isolates *source* but historically
leaked through *dependencies*, *probe state*, *shallow gates*, and
*un-revalidated merges*. This tracks the full hardening pass.

Origin: an 11-issue audit of the self_edit path. Issue #1 in that audit (the
junction-teardown traversal fix) shipped before this pass. The remaining 10 are
tracked below as two passes.

> **✅ RESOLVED (2026-05-31):** the bind-gate failure ("did not bind within 60s")
> was a self-inflicted regression — the Pass 2 #11 orphan sweep unlinked the
> probe's own worktree `node_modules` mid-boot. Fixed in `524dbcd6`; bind+smoke
> verified green. Full write-up in the **"RESOLVED: bind gate"** section at the
> bottom.

## Gate order (current, after Pass 2)

```
fingerprint-parent-deps → spawnClaude[scrubbed env] → verify-parent-deps(restore+abort if mutated)
  → deps → build → bind → smoke → security-scope(HOLD if security/auth/policy touched)
  → exfil-scan(HOLD if secret-shaped content staged in diff)
  → merge → re-gate(rebuild merged main) → record(boot-pending)
  → [next boot] confirmMergeBoot on bind / revertPendingMergeIfCrashed on crash
```

The subprocess is spawned with a **scrubbed env** (Pass 4) so it can't inherit
the user's credentials — and the gates that later EXECUTE its output (`gateBuild`,
the `gateBind` probe) run scrubbed too, so it can't exfil via written code
either. Its output is secret-redacted before it reaches chat/logs.

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
- `src/self-edit/child-env.ts` — confidentiality scrub of the `claude -p` child env (Pass 4, M1)
- `src/self-edit/exfil-scan.ts` — staged-secret tripwire on the produced diff (Pass 4, M4)
- `src/mcp-client/env-credential-patterns.ts` — shared child-env policy data (allowlist + credential-deny tables); canonical for env scrubbing across MCP + self_edit
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

## Pass 4 — SHIPPED (#6 — exfiltration / confidentiality)

The first non-brick gap addressed. Passes 1–3 defend INTEGRITY/AVAILABILITY
(bricking). Pass 4 defends CONFIDENTIALITY: a prompt-injected subprocess
(injection via the task text OR via repo/workspace content it reads) reading
secrets/tokens and bashing them out to the network. Canonical owner: the child
env scrubber already used for MCP children (`buildMcpChildEnv` +
`env-credential-patterns.ts`); Pass 4 extends it to the self_edit child rather
than forking a new scrubber.

- **M1 — Child env scrub (the root-cause fix).** Both `claude -p` spawn sites
  (`bypass-runner.ts`, `spawnClaude` in `self-edit-sandbox-gates.ts`) used to
  pass `npmAugmentedEnv()` = `{...process.env}`, handing every credential in the
  LAX server env to the child. Replaced with `buildSelfEditChildEnv()`
  (`src/self-edit/child-env.ts`): default-deny — only the non-credential
  allowlist passes through (binary resolution / shell / locale / temp / home),
  plus the child's OWN Anthropic auth (`ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) so API-key installs still
  authenticate. The `ENV_ALLOWLIST` was moved to `env-credential-patterns.ts`
  so the MCP and self_edit scrubbers share one source of truth.
  - **Gate-execution scrub (M1 follow-up).** Scrubbing only the `claude -p`
    child left a side door: an injected child needn't read creds itself — it can
    write `process.env.SECRET`-exfil code that the gates which EXECUTE its output
    then run with the full env. So `gateBuild` (`npm run build`) and the
    `gateBind` probe (which BOOTS the worktree app — the richest exfil runtime)
    now run under `buildSelfEditChildEnv()` too (`runCommandInWorktree` gained an
    optional `env`). The probe defaults to the `anthropic` provider on its fresh
    empty data dir, so the only provider cred it can use is the Anthropic auth
    the scrub already passes through — verified end-to-end: LAX boots, binds, and
    the smoke chat returns 200 under the scrubbed env.
- **M4 — Staged-secret tripwire (detective).** `scanWorktreeForStagedSecrets`
  (`src/self-edit/exfil-scan.ts`) scans the ADDED content of the worktree diff
  (tracked additions + new untracked files) against the canonical
  `secret-scanner.ts` catalog before merge; a hit HOLDs the merge for human
  review (same posture as the security diff-scope gate, branch preserved).
  Catches a child STAGING a scraped credential into source (rides out on the
  eventual commit/push). Subprocess stdout is also secret-redacted before it
  reaches chat/logs (both sandbox + bypass paths). False positives are possible
  (test fixtures, edits to the pattern catalog itself) — by design it's a HOLD,
  not a hard fail.

Tests: `test/self-edit-child-env.test.ts` (env scrub guarantees),
`test/self-edit-exfil-scan.test.ts` (pure staged-secret detection). Verified:
`npm run build` clean; both suites green (11 tests); MCP env + prior self-edit
suites still green (27 tests).

### What M1+M4 do NOT close (honest residuals)
- **Anthropic-credential exfil (irreducible).** After M1 the child still holds
  an Anthropic credential — whether via the env passthrough or its own
  `~/.claude` OAuth store — and an injected child can read+exfil it. This is
  inherent to running a Claude subprocess and cannot be closed without an
  OS-level egress jail (M3, below — not shipping). M1 removes the *bulk*
  credential-from-env path (GitHub/AWS/Stripe/LAX-token/etc.), not this one.
- **Live network egress (M3 — NOT shipping, deliberately).** Truly preventing a
  child from POSTing a secret it read from disk via raw bash needs WFP /
  AppContainer / a forced proxy — heavyweight, per-machine, brittle on Windows,
  and not enforceable out-of-the-box. Anything lighter would be security
  theater, so we don't ship it. M4 is the detective compensating control for
  the staging/output sub-case; the diff-scope hold + encrypted-at-rest vault
  (`secrets.enc`/`auth.json`, DPAPI master key) cover the rest.
- **`gateDeps` (`npm ci`) keeps the real env (deliberate).** Scrubbing it would
  break enterprise installs — private-registry tokens, proxy/registry/cache
  config that a strict allowlist drops — and its only code-exec vector (a
  malicious `postinstall`) requires a dependency-manifest change, which only
  runs the deps gate at all when `package.json`/lock changed and is a visible,
  reviewable diff. The build + bind gates (which run on every self_edit) carry
  the scrub; deps does not.
- **M2 — Disposable `LAX_DATA_DIR` for the child (considered, deferred —
  marginal).** Generalizing `gateBind`'s temp-dir pattern to the child only
  redirects LAX-code reads of the data dir; raw `cat ~/.lax/...` still resolves
  via `~`, and those blobs are encrypted anyway. Near-zero value for this
  threat; not worth the moving part. Revisit only if a future feature makes the
  child run LAX code that reads the data dir by env.

> Billing note (not security): if a user has BOTH a Max-subscription OAuth
> login and a stray `ANTHROPIC_API_KEY` in env, the passthrough makes the child
> bill against the API key instead of the subscription. A nuance, not a leak;
> not solved here.

### Accepted / out-of-scope (not brick vectors)
- **Fail-open intent/scope gates** — deliberate: better to allow an occasional
  misroute than block legit self_edits when the classifier is flaky. Left as-is.

## Backlog — committed follow-ups (DO NOT DROP)

Tracked deliberately; the user does not want these skipped.

- **Branch cleanup in the boot-sweep.** `sweepOrphanWorktreeJunctions`
  (worktree.ts) removes orphaned worktree *dirs* + prunes the registry, but
  leaves the `selfedit/<slug>/<ts>` (and `autopilot/<slug>/<ts>`) git *branches*
  behind. They accumulate as harmless refs forever. → After the sweep, delete
  branches that match the sandbox/autopilot naming pattern and are fully merged
  OR whose worktree is gone. Be careful not to delete a branch with an active
  worktree (the sweep already skips those).
- **Harden `killProbe` process-tree kill.** On Windows, `spawn(..., {shell:true})`
  wraps the child in cmd.exe, so `proc.kill()` only signals the wrapper and
  leaves the real `node`/`tsx` tree alive (this leaked probes during the
  2026-05-30 bind-gate debugging). `killProbe` (self-edit-sandbox-gates.ts) must
  use the same `killProcessTree` (taskkill /F /T) the bypass-runner already uses,
  not a bare `proc.kill`. Same gap may exist anywhere a probe/worktree process is
  killed.
- **#7 probe-port collision.** The autopilot end-of-shift boot proof
  (boot-proof.ts) picks its probe port from `pid+time` and does NOT hold the
  global self_edit lock, so it can collide with a concurrent sandbox probe port →
  false "boot proof failed". Cosmetic (no brick), but real. → Either serialize
  the boot proof under the global lock, or retry on EADDRINUSE with a fresh port.
- **Boot sweep can nuke an ACTIVE self_edit worktree on a mid-self_edit restart.**
  The probe case is fixed (`LAX_SELF_EDIT_PROBE` skip), but the REAL server's
  boot sweep still treats every `%TEMP%/lax-worktrees` dir as an orphan — so
  restarting LAX while a self_edit is mid-flight would unlink that live worktree's
  junction out from under it. Narrow edge case (restart during an active
  self_edit). → Add a "skip junctions currently in use" guard: the sweep already
  leaves EBUSY/locked reparse points alone; extend it to detect an in-use
  junction before unlinking rather than relying on the unlink failing.

## RESOLVED: bind gate — orphan sweep nuked the probe's own worktree (2026-05-31)

**Root cause.** The Pass 2 #11 orphan-worktree sweep
(`sweepOrphanWorktreeJunctions`, wired into `index.ts` boot) runs on EVERY boot
and treats everything under `%TEMP%/lax-worktrees` as an orphan. The bind probe
BOOTS from a worktree INSIDE that directory — so the probe's own boot sweep
unlinked the `node_modules` junction it was booting on, mid-boot. The next
import after the unlink (`@arikernel/tool-executors`) failed with "Cannot find
package", boot never reached `server.listen`, and the gate timed out at 60s.

A self-inflicted regression from the very hardening shipped in Pass 2 — which is
why self_edit "worked before" (the sweep didn't exist) and why isolated repros
kept diverging: test worktrees placed OUTSIDE `lax-worktrees` were never swept,
so they booted further and pointed at red herrings (ari dist, tool-rag).

**Fix (`524dbcd6`).** `gateBind` sets `LAX_SELF_EDIT_PROBE=1` on the probe env;
boot skips the orphan sweep when it's set (`index.ts`). Only the real server —
which never lives under `lax-worktrees` — sweeps.

**Verified.** Faithful gate chain (`createNamedWorktree` worktree inside
`lax-worktrees`, forked from the fixed HEAD): build 38.9s, **bind 17.9s**, smoke
green (`chat replied (186 bytes) + 3 endpoints healthy`). Was: never bound / 60s
timeout.

**Loose ends cleared up along the way:**
- `4d29c380` (ConfigWatcher graceful-skip) was correct in SOURCE but the running
  `dist/` was STALE — `dist/` is gitignored, so a source fix never travels with
  the commit; the running build must be rebuilt. After a rebuild, repo-root bound
  in 14.5s. Lesson: after fixing code the probe boots (`dist`), rebuild before
  re-testing, and ensure exactly ONE clean server instance.
- `bed838f5` (probe boots `npm start`/dist, not tsx) stands — unrelated to the
  bug, kept.
- The "tool-rag pre-warm blocks bind" hypothesis was WRONG: tool-rag pre-warm is
  fire-and-forget in `server/index.ts` and does not gate `server.listen`. The
  blocking phases are bootstrapServices → bootstrapTools → createHttpServer →
  setupVoiceWs → startConfigWatcher → bootstrapCanonicalLoop; the sweep (run
  BEFORE startServer) was the real culprit.

**Follow-up:** see the backlog item "Boot sweep can nuke an ACTIVE self_edit
worktree on a mid-self_edit restart" — the probe case is fixed, the real-server
mid-self_edit-restart edge case is not.
