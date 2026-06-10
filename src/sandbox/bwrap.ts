// Linux namespace sandbox (bubblewrap / bwrap) for the agent shell.
//
// This is the Linux sibling of seatbelt.ts — the native, Docker-free arm of
// the sandbox subsystem. Where "docker" mode runs shell commands inside an
// Alpine container, "bwrap" keeps them on the host but inside kernel
// namespaces set up by bubblewrap. bwrap is transparent like sandbox-exec —
// it builds the namespaces then execs the target — so the caller's spawn
// machinery (streaming, timeout, kill) is unchanged; only the argv differs.
//
// Posture (deliberately a TARGETED deny, not a hermetic jail — same rationale
// as seatbelt.ts): a general host dev shell can't be default-deny without
// breaking the package managers/build tools it exists to run. So bwrap binds
// the host root read-write and hard-denies the three things that matter:
//   1. ALL external network — --unshare-net gives a loopback-only namespace;
//      external routes simply don't exist, closing the curl/wget/nc//dev/tcp
//      egress cluster at the namespace, not by binary name.
//   2. Read AND write of the sensitive home dirs (~/.ssh, ~/.aws, ~/.lax, …) —
//      each shadowed by an empty --tmpfs; derived from the ONE list in
//      sandbox/validate.ts. Reads see nothing, writes are throwaway.
//   3. Sensitive files + shell-rc persistence — each shadowed by
//      --ro-bind /dev/null, so reads are empty and writes fail.
//
// Paths MUST be realpath'd (the mount table holds canonical paths — a
// symlinked home dir would otherwise leave the real target exposed) and MUST
// exist (bwrap aborts the whole invocation on a missing tmpfs/bind target,
// which would break every shell command, not just weaken the cage).

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES } from "./validate.js";

// Shell rc files a confined shell must not be able to persist into. The
// launch-agent analog on Linux (~/.config/systemd/user, ~/.config/autostart)
// is already covered by the ~/.config entry in HOME_RELATIVE_DENY_DIRS.
const SHELL_RC_FILES = [
  ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv",
];

// Memoized PATH probe — spawns `which`, deterministic per process.
let bwrapOnPath: boolean | null = null;

/** Linux with bwrap on PATH. Bwrap mode is a no-op everywhere else. */
export function isBwrapAvailable(): boolean {
  if (process.platform !== "linux") return false;
  if (bwrapOnPath === null) {
    try {
      execFileSync("which", ["bwrap"], { stdio: "ignore", timeout: 5000 });
      bwrapOnPath = true;
    } catch {
      bwrapOnPath = false;
    }
  }
  return bwrapOnPath;
}

// Canonicalize for embedding in the mount table. realpath when it exists;
// otherwise return as-is (the existsSync gate below drops it anyway).
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Build the bwrap argv that precedes the shell + its args. `home` is
 * injectable for tests; defaults to the real home. Only emits --tmpfs /
 * --ro-bind entries for targets that exist — bwrap errors out on missing
 * targets, which would break every shell command.
 */
export function generateBwrapArgs(home: string = homedir()): string[] {
  const realHome = canonical(home);

  const args = [
    "--bind", "/", "/",        // full host RW so the dev shell stays usable
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-net",           // loopback-only network namespace
    "--die-with-parent",       // caller's kill/timeout reaches the confined child
  ];

  for (const dir of HOME_RELATIVE_DENY_DIRS) {
    const p = canonical(join(realHome, dir));
    if (existsSync(p)) args.push("--tmpfs", p);
  }

  const denyFiles = new Set([...HOME_RELATIVE_DENY_FILES, ...SHELL_RC_FILES]);
  for (const file of denyFiles) {
    const p = canonical(join(realHome, file));
    if (existsSync(p)) args.push("--ro-bind", "/dev/null", p);
  }

  return args;
}

/**
 * Wrap an intended `(shell, shellArgs)` spawn so it runs under bwrap.
 * Returns the original pair unchanged when bwrap isn't available, so callers
 * can wrap unconditionally. bwrap exits non-zero if it can't build the cage
 * (e.g. userns denied), so a broken cage fails the command loudly rather
 * than running unconfined.
 */
export function wrapForBwrap(
  shell: string,
  shellArgs: string[],
  home?: string,
): { cmd: string; args: string[] } {
  if (!isBwrapAvailable()) return { cmd: shell, args: shellArgs };
  return { cmd: "bwrap", args: [...generateBwrapArgs(home), shell, ...shellArgs] };
}

/**
 * Empirical self-check that the cage actually holds on THIS kernel. Used by
 * the mode resolver to fail closed. Requires BOTH:
 *  - the wrapped invocation ran at all (RAN sentinel) — catches "bwrap present
 *    but unprivileged userns disabled" (Debian hardened, RHEL, Docker default
 *    seccomp) and any tmpfs/bind that errors, which would otherwise break
 *    every shell command;
 *  - the network is actually denied (NET-BLOCKED sentinel) — probes
 *    192.0.2.1 (TEST-NET-1, RFC 5737, unroutable; no real traffic ever leaves).
 */
export function bwrapEnforces(home?: string): boolean {
  if (!isBwrapAvailable()) return false;
  const probe = "exec 3<>/dev/tcp/192.0.2.1/80 && echo NET-OK || echo NET-BLOCKED; echo RAN";
  try {
    const out = execFileSync(
      "bwrap",
      [...generateBwrapArgs(home), "/bin/bash", "-c", probe],
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.includes("RAN") && out.includes("NET-BLOCKED");
  } catch {
    return false;
  }
}
