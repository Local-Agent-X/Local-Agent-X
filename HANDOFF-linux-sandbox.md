# Handoff — finish Round-5 Phase A: Linux `bwrap` shell confinement

**You are continuing a security feature on a Linux-capable machine (this box has
Docker; the author's macOS box did not, so the Linux arm was handed to you to
implement *and verify in a real Linux container*).** Delete this file in your
final commit.

## What's already done (don't redo)

Phase A = OS-level confinement of the agent shell (`bash` + `process_start`),
extending the existing `src/sandbox/` subsystem (no fork). The **macOS arm is
complete, verified, and pushed**: a new opt-in `seatbelt` `SandboxMode` runs
shell children under `/usr/bin/sandbox-exec` with a kernel profile. Read these
to mirror the structure exactly:

- `src/sandbox/seatbelt.ts` — the macOS mechanism. **Your `bwrap.ts` mirrors this file.**
- `src/sandbox/index.ts` — `getSandboxMode()` (env + config resolution, fail-closed
  fallback to `host`, memoized usability probe), `wrapSpawnForSandbox()`,
  `setSandboxMode()`.
- `src/sandbox/seatbelt.test.ts` — unit + live `sandbox-exec` enforcement tests. **Your `bwrap.test.ts` mirrors this.**
- `src/sandbox/validate.ts` — exports `HOME_RELATIVE_DENY_DIRS` / `HOME_RELATIVE_DENY_FILES`,
  the **single source** both mechanisms derive their sensitive-path denies from.
  Do NOT author a second list.
- `src/tools/shell-tool.ts` + `src/tools/process-session.ts` — both already call
  `wrapSpawnForSandbox(shell, shellArgs)` and spawn the result. **You do not touch
  these** — they're mechanism-agnostic; making `getSandboxMode()` return `"bwrap"`
  is enough.

Full design rationale: `ari-redteam-round5.md` (gitignored, local to the mac box —
not in your tree; the summary below is sufficient).

## The design (decided — implement, don't redesign)

**Mechanism: bubblewrap (`bwrap`), not Landlock.** Landlock has no CLI wrapper
(raw syscall, needs a C helper) and can't restrict network before kernel 6.7.
`bwrap` is the userspace "wrap the command" analog to `sandbox-exec` and does both
net + fs in one tool.

**Posture: targeted-deny, mirroring seatbelt** — a general host dev shell can't be
default-deny without breaking the package managers it exists to run (that's why
`docker` mode is a fresh container). So: keep the host shell usable, hard-deny the
three things rounds 2-4 kept patching:
1. **All external network** — `--unshare-net` (loopback-only namespace; external
   routes gone). The headline; closes the egress cluster at the namespace, not by
   binary name.
2. **Read+write of the sensitive home dirs** — shadow each with `--tmpfs` (empty
   overlay: reads see nothing, writes are throwaway). Derived from
   `HOME_RELATIVE_DENY_DIRS`.
3. **Sensitive files + shell-rc persistence** — shadow each with
   `--ro-bind /dev/null <file>`. From `HOME_RELATIVE_DENY_FILES` + the shell-rc set
   (`.bashrc .bash_profile .profile .zshrc .zprofile .zshenv`).

**Add `"bwrap"` as a concrete `SandboxMode`** (parallel to `"seatbelt"`/`"docker"`),
NOT a generic "native". Per-platform availability fallback already handles "wrong
value for this OS → host". Touch: `src/sandbox/types.ts`, `src/config.ts` (zod enum
+ the doc comment), `src/sandbox/index.ts` (env branch `LAX_SANDBOX=bwrap`, config
branch, `setSandboxMode` validation, `wrapSpawnForSandbox`). `src/types.ts` already
uses the `SandboxMode` type — no change needed there.

## `src/sandbox/bwrap.ts` spec (mirror seatbelt.ts)

```
isBwrapAvailable(): process.platform === "linux" && bwrap on PATH (which/execFileSync probe)
generateBwrapArgs(home = homedir()): string[]   // the args BEFORE the shell+cmd
wrapForBwrap(shell, shellArgs, home?): { cmd: "bwrap"|shell, args }   // passthrough if unavailable
bwrapEnforces(home?): boolean   // EMPIRICAL self-check, see below
```

`generateBwrapArgs` (only emit binds/tmpfs for paths that **exist** —
`existsSync` — bwrap errors on a missing tmpfs/bind target, which would break
every shell command; realpath each like seatbelt does):
```
--bind / /            // full host RW so the dev shell stays usable
--dev /dev
--proc /proc
--unshare-net
  for each existing realpath'd sensitive dir:   --tmpfs <dir>
  for each existing realpath'd sensitive file:  --ro-bind /dev/null <file>
  for each existing realpath'd shell-rc file:   --ro-bind /dev/null <file>
```
(`~/.config` is in the shared list, so `~/.config/systemd/user`,
`~/.config/autostart`, gcloud ADC etc. are all covered by that one `--tmpfs`.)

`wrapForBwrap` returns `{ cmd: "bwrap", args: [...generateBwrapArgs(home), shell, ...shellArgs] }`,
or `{ cmd: shell, args: shellArgs }` when `!isBwrapAvailable()`.

### `bwrapEnforces` — the gate that makes shipping-without-the-author-testing safe

Run the **full** wrapped invocation around a probe and require BOTH:
- the invocation actually ran on this kernel (stdout contains a `RAN` sentinel) —
  catches "bwrap present but unprivileged userns disabled" (hardened distros) and
  any tmpfs/bind that errors → those fall back to `host`, not a broken shell;
- network is actually denied — probe `/dev/tcp/192.0.2.1/80` (TEST-NET-1, RFC5737,
  unroutable; no real traffic) and require a `NET-BLOCKED` sentinel.

```
probe = 'exec 3<>/dev/tcp/192.0.2.1/80 && echo NET-OK || echo NET-BLOCKED; echo RAN'
execFileSync("bwrap", [...generateBwrapArgs(home), "/bin/bash","-c",probe], {timeout:5000})
return out.includes("RAN") && out.includes("NET-BLOCKED")
```

Wire it into `index.ts` exactly like `isSeatbeltUsable()`: a memoized
`isBwrapUsable() = isBwrapAvailable() && bwrapEnforces()`, used by the env branch,
the config branch, and `setSandboxMode`. Fail-closed: unusable → `host` + a
`logger.warn`.

## Verification — REQUIRED before you push (this is the whole point of your box)

1. `npm run build` clean (400-LOC source-hygiene gate + tsc — not just tsc).
2. `npm run test:unit` green (currently 4747 passed | 7 skipped — your new file
   adds unit tests; the live bwrap test is `describe.skipIf(!linux || !bwrap)`).
3. **Live enforcement in a real Linux container** — the reason this was handed to
   you. bwrap inside Docker usually needs relaxed seccomp/privileges for the user
   namespace; if the container can't run bwrap, `bwrapEnforces` will correctly
   report false (host fallback) — but to actually verify the *cage*, run it where
   bwrap works:
   ```
   docker run --rm -it --privileged -v "$PWD:/app" -w /app node:22-bookworm bash -lc '
     apt-get update -qq && apt-get install -y -qq bubblewrap >/dev/null
     # sanity: bwrap works in this container
     bwrap --bind / / --dev /dev --proc /proc --unshare-net /bin/bash -c "echo OK" || { echo "bwrap cant run here — try --security-opt seccomp=unconfined"; exit 1; }
     npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1
     npx vitest run src/sandbox/bwrap.test.ts
   '
   ```
   Your `bwrap.test.ts` live block must assert, against a synthetic `mkdtemp` home
   (mirror seatbelt.test.ts): ordinary command runs; `--tmpfs`'d `.ssh` reads
   empty (planted secret NOT visible); a non-sensitive file under the same home
   reads fine; `/dev/tcp/192.0.2.1/80` is BLOCKED.
4. End-to-end: `LAX_SANDBOX=bwrap` inside the container →
   `getSandboxMode()==="bwrap"`, `wrapSpawnForSandbox` → `cmd==="bwrap"`, a confined
   `echo` works and a confined network probe is blocked (mirror the macOS e2e drive
   from the last session).

## Gotchas (learned on the macOS arm)

- **realpath every embedded path.** The kernel matches the canonical path; on mac
  a deny of `/tmp/x` silently no-op'd because it resolves to `/private/tmp/x`. On
  Linux the analog is a symlinked home dir — realpath the dir before `--tmpfs`/`--bind`.
- **Only bind/tmpfs paths that exist** — bwrap aborts the whole invocation on a
  missing target, which would break every shell command (not just weaken the cage).
- **Unprivileged userns may be disabled** (Debian hardened, RHEL default-off,
  Docker default seccomp). `bwrapEnforces` is what keeps that from becoming a
  broken shell — it downgrades to `host`.

## When done

Commit (delete this handoff file in that commit), push from the Linux box, then
come back to the mac and tell the agent "Linux done, continue" — the next item is
**Round-5 Phase B: whole-server confinement** (tracked in `ari-redteam-round5.md`).
Don't start Phase B from the Linux box.
