# HANDOFF — Windows sandbox arm ("phase W", shell children)

For a Claude session on the Windows machine. Read this whole file before
writing code. When the work is done and verified, commit to `main`, **delete
this file in the finishing commit** (precedent: HANDOFF-linux-sandbox.md), and
push.

## Where things stand

- **Phase A (shipped):** agent shell children run under a kernel sandbox on
  macOS (`seatbelt`, src/sandbox/seatbelt.ts) and Linux (`bwrap`,
  src/sandbox/bwrap.ts). Targeted deny: all outbound network, read+write of
  the sensitive home dirs, write of persistence vectors.
- **Phase B (shipped, 58c7721c):** whole-server confinement on macOS/Linux via
  boot re-exec (src/sandbox/server-confine.ts) with a 2-strike boot-failure
  escape hatch.
- **Windows: the documented gap.** Only the in-process best-effort guards
  (shell-policy denylist, path guard) apply. No kernel enforcement. This
  handoff is the SHELL-CHILDREN arm only — see "Out of scope" at the bottom.

## The contract (non-negotiable — it's what made the other two arms safe)

1. **Transparent spawn wrapper.** The only integration point is
   `wrapSpawnForSandbox(shell, shellArgs)` in src/sandbox/index.ts returning
   `{ cmd, args }`. Callers (src/tools/shell-tool.ts, src/tools/
   process-session.ts) already wrap unconditionally; their streaming/timeout/
   kill machinery must keep working unchanged. On Windows the wrapped target
   is `powershell.exe -NoProfile -Command <cmd>` — note process_kill uses
   `taskkill /T /PID`, so the confined tree must die with it.
2. **Single source of truth.** Sensitive paths come from
   `HOME_RELATIVE_DENY_DIRS` / `HOME_RELATIVE_DENY_FILES` in
   src/sandbox/validate.ts. Windows-specific persistence vectors (HKCU
   `Run`/`RunOnce` keys, the Startup folder, PowerShell `$PROFILE`) are
   defined in the new module the way seatbelt.ts defines LaunchAgents —
   local consts, never a second copy of the shared lists.
3. **Fail-closed empirical self-check.** Mirror `bwrapEnforces()`: run a REAL
   confined probe and require positive evidence (e.g. `RAN` sentinel + a
   network attempt to 192.0.2.1 reporting blocked + a planted synthetic
   secret unreadable). Memoize it in src/sandbox/index.ts exactly like
   `isBwrapUsable()`. "Mechanism present" never equals "cage holds" — if the
   probe fails, the mode resolver falls back to `host` with a loud warning,
   and `setSandboxMode` rejects with a clear message.
4. **OTA-deliverable.** No compiled binary committed to the repo. PowerShell
   (including `Add-Type` P/Invoke) is acceptable; keep any .ps1 content
   generated from TypeScript so it derives from validate.ts at runtime.
5. **Targeted deny, not hermetic.** The dev shell must stay usable:
   `npm install` (minus network if network is denied — same as the other
   arms), `git status`, file I/O in the workspace all work. Default-deny
   that breaks the shell is a non-starter; that posture is docker mode.

## Mechanism — investigate in this order, decide empirically

1. **AppContainer** (recommended first try). Per-process, inheritable,
   kernel-enforced, no admin. Network is denied unless the `internetClient`
   capability is granted — that's the network deny for free. The risk is
   filesystem: AppContainer is default-deny on most of the user profile, so
   probe whether a usable dev shell is achievable (many system paths already
   carry `ALL APPLICATION PACKAGES` read ACEs; workspace dirs can be granted
   to the container SID at session start). Launching needs
   `CreateAppContainerProfile` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
   — doable from PowerShell via Add-Type P/Invoke without shipping a binary.
   If the FS probe shows npm/git break inside it, record why and move on.
2. **Dedicated restricted local user** (needs admin once, at install/opt-in):
   create a `lax-shell` user, `icacls` deny ACEs derived from validate.ts on
   the sensitive dirs, `New-NetFirewallRule -LocalUser` outbound block.
   Heavier setup, credential plumbing for spawn-as-user is awkward — only
   pursue if AppContainer fails the usability probe.
3. **"Not feasible" is an acceptable verdict.** If neither passes the
   contract, the deliverable becomes: a short section in THREAT-MODEL.md
   stating Windows native confinement was evaluated and why it failed, and
   making docker mode the documented Windows answer. An honest no beats a
   cage that doesn't hold — do not ship a wrapper whose self-check you had
   to weaken to pass.

## Files (EXTEND the canonical sandbox subsystem — no new top-level dirs)

- `src/sandbox/appcontainer.ts` (or rename to match the chosen mechanism) —
  mirror seatbelt.ts's API shape: `isXAvailable()`, the arg/profile
  generator (home injectable for tests), `wrapForX(shell, shellArgs, home?)`,
  `xEnforces(home?)`.
- `src/sandbox/types.ts` — add the mode name to `SandboxMode`.
- `src/sandbox/index.ts` — memoized `isXUsable()`, env + config branches in
  `getSandboxMode()` (fall back to host + warn), routing in
  `wrapSpawnForSandbox()`, validation in `setSandboxMode()`.
- `src/config.ts` — add the mode to the `sandboxMode` z.enum + doc comment.
- `src/sandbox/appcontainer.test.ts` — mirror bwrap.test.ts: arg-construction
  unit tests that run everywhere + `describe.skipIf(!onWin32)` live
  enforcement tests (synthetic home via mkdtemp, planted fake secret,
  TEST-NET-1 network probe; never real secrets).

## Verification on the Windows box (all must pass before pushing)

```
npx vitest run src/sandbox/        # live win32 tests green
npm run build                      # tsc + 400-LOC hygiene gate + no-require
npm run test:unit                  # full suite, no regressions
```
Then manual: `LAX_SANDBOX=<mode>` → bash tool: network probe blocked,
planted synthetic `.ssh` unreadable, workspace writes fine, `taskkill`-based
process_kill still reaps the tree.

## Out of scope for this handoff

- **Whole-server confinement on Windows** (phase B analog) — needs its own
  design pass (no POSIX signals/process groups; the escape-hatch launcher
  semantics differ). Do shell children first.
- Settings-UI work — the existing Settings → Security toggle picks up new
  `sandboxMode` values from the enum; anything fancier is a separate change.

Commit to `main` directly (no feature branches), push when verified, and
delete this file in the finishing commit.
