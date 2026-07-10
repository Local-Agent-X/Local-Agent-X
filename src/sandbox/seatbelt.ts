// macOS kernel sandbox (seatbelt / sandbox-exec) for the agent shell.
//
// This is the native, Docker-free arm of the sandbox subsystem. Where the
// "docker" mode runs shell commands inside an Alpine container, "seatbelt"
// keeps them on the host but under a kernel sandbox profile applied by
// /usr/bin/sandbox-exec. sandbox-exec is transparent — it applies the profile
// then execs the target in place — so the caller's spawn machinery (streaming,
// timeout, kill) is unchanged; only the argv it spawns differs.
//
// Posture (deliberately a TARGETED deny, not a hermetic jail): a general host
// dev shell can't be default-deny without breaking the package managers/build
// tools it exists to run (the reason docker mode is a fresh container, not a
// host jail). So seatbelt allows the host shell by default and hard-denies the
// three things that actually matter and that rounds 2-4 kept patching by hand:
//   1. ALL outbound network — closes the curl/wget/nc/openssl/websocat/
//      /dev/tcp egress cluster categorically, at the syscall, not by binary name.
//   2. Read AND write of the sensitive home dirs (~/.ssh, ~/.aws, ~/.lax, …) —
//      the crown jewels, derived from the ONE list in sandbox/validate.ts.
//   3. Write of the classic persistence vectors (LaunchAgents/Daemons, shell rc).
// Hermetic, write-everywhere-denied confinement remains docker mode / phase B
// (whole-server). See ari-redteam-round5.md.
//
// The "guarded" scope is the DEFAULT posture: items 2 and 3 (credential +
// persistence denies) WITHOUT item 1 (network) and exempting ~/.config — so the
// kernel backstops the command parser's $VAR/$(...) blind spot on credentials
// while npm/git/curl keep working. The "shell" scope is the strict opt-in that
// adds the network deny and denies ~/.config too.
//
// Subpaths MUST be realpath'd: the kernel matches the canonical path, so a deny
// of "/tmp/x" never fires (it resolves to /private/tmp/x), and a deny of the
// realpath fires even when the access comes in via a symlink alias — which is
// what closes the symlink-escape TOCTOU at the kernel level.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, SERVER_SCOPE_EXEMPT_DIRS, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";
import type { SandboxScope } from "./types.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** macOS with sandbox-exec present. Seatbelt mode is a no-op everywhere else. */
export function isSeatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

// Canonicalize a path for embedding in a profile. realpath when it exists (so a
// symlinked sensitive dir resolves to its real target); otherwise canonicalize
// the deepest existing ancestor (the home root) and re-append the tail, so a
// not-yet-created target (~/.codex on a machine that never ran codex) still gets
// a /private-correct prefix.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// SBPL string literals are double-quoted; backslash and quote must be escaped.
function sb(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Persistence vectors a confined shell must not be able to write, regardless of
// file-access mode. Home-relative shell rc files + launch-agent dirs (user and
// system); the absolute /Library ones need root anyway but the deny is free.
const HOME_PERSISTENCE_FILES = [
  ".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile",
];
const HOME_PERSISTENCE_DIRS = ["Library/LaunchAgents", "Library/LaunchDaemons"];
const ABSOLUTE_PERSISTENCE_DIRS = ["/Library/LaunchAgents", "/Library/LaunchDaemons"];

/**
 * Build the sandbox-exec profile. `home` is injectable for tests; defaults to
 * the real home. The realHome is canonicalized once and used as the base for
 * relative entries.
 *
 * "shell" scope (phase A) confines agent shell children: network denied, all
 * sensitive home dirs denied. "server" scope (phase B) confines the whole Node
 * server: network stays allowed (the server's API egress goes through the
 * in-process canonicalFetch chokepoint, which governs destinations — SBPL can
 * only filter by IP, not hostname) and the dirs the server itself owns
 * (~/.lax, ~/.codex) are exempted. Persistence write-denies apply to both.
 */
export function generateSeatbeltProfile(home: string = homedir(), scope: SandboxScope = "shell"): string {
  const realHome = canonical(home);

  const exemptDirs =
    scope === "server" ? SERVER_SCOPE_EXEMPT_DIRS :
    scope === "guarded" ? GUARDED_SCOPE_EXEMPT_DIRS :
    new Set<string>();
  const denyDirs = HOME_RELATIVE_DENY_DIRS.filter((d) => !exemptDirs.has(d));
  const sensitiveSubpaths = denyDirs.map((d) => canonical(join(realHome, d)));
  const sensitiveFiles = HOME_RELATIVE_DENY_FILES.map((f) => canonical(join(realHome, f)));

  const persistenceFiles = HOME_PERSISTENCE_FILES.map((f) => canonical(join(realHome, f)));
  const persistenceSubpaths = [
    ...HOME_PERSISTENCE_DIRS.map((d) => canonical(join(realHome, d))),
    ...ABSOLUTE_PERSISTENCE_DIRS,
  ];

  const lines = [
    "(version 1)",
    "(allow default)",
    ...(scope === "shell" ? ["(deny network*)"] : []),
    // Crown jewels: deny every file op (read, write, exec, …) on the sensitive
    // home dirs. file* is the umbrella operation.
    `(deny file* ${sensitiveSubpaths.map((p) => `(subpath ${sb(p)})`).join(" ")})`,
    `(deny file* ${sensitiveFiles.map((p) => `(literal ${sb(p)})`).join(" ")})`,
    // Persistence: read is harmless, deny only writes.
    `(deny file-write* ${persistenceSubpaths.map((p) => `(subpath ${sb(p)})`).join(" ")})`,
    `(deny file-write* ${persistenceFiles.map((p) => `(literal ${sb(p)})`).join(" ")})`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Wrap an intended `(shell, shellArgs)` spawn so it runs under the seatbelt
 * profile. Ordinary callers can request passthrough when seatbelt is not active;
 * callers that already selected Seatbelt pass `required=true` and fail closed
 * if sandbox-exec disappeared after capability detection. The profile is passed
 * inline via `-p`, so a malformed profile also fails the command loudly.
 */
export function wrapForSeatbelt(
  shell: string,
  shellArgs: string[],
  home?: string,
  scope: SandboxScope = "shell",
  required = false,
): { cmd: string; args: string[] } {
  if (!isSeatbeltAvailable()) {
    if (required) throw new Error(`Required sandbox executable is unavailable: ${SANDBOX_EXEC}`);
    return { cmd: shell, args: shellArgs };
  }
  const profile = generateSeatbeltProfile(home, scope);
  return { cmd: SANDBOX_EXEC, args: ["-p", profile, shell, ...shellArgs] };
}

/** One-shot self-check that the generated profile actually loads. Used by the
 *  mode resolver to fail closed: if sandbox-exec rejects our own profile on
 *  this OS version, we must not silently treat the shell as confined. */
export function seatbeltProfileLoads(home?: string, scope: SandboxScope = "shell"): boolean {
  if (!isSeatbeltAvailable()) return false;
  try {
    execFileSync(SANDBOX_EXEC, ["-p", generateSeatbeltProfile(home, scope), "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
