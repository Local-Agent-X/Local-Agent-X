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
//
// The "guarded" scope is the DEFAULT posture: the sensitive-dir/file shadowing
// exempting ~/.config, so the namespace backstops the command parser's
// $VAR/$(...) blind spot on credentials while npm/git/curl keep working. Its
// network is the caller's choice (BwrapNetwork): the agent SHELL runs in an
// empty network namespace with the egress bridge — nothing off the machine,
// the host's loopback only through the proxy, which is the same invariant
// macOS guarded enforces with seatbelt — while a sandboxed MCP server keeps the
// host network, because nothing routes its traffic through the proxy yet. The
// "shell" scope is the strict opt-in: --unshare-net with no bridge, and
// ~/.config shadowed too.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, SERVER_SCOPE_EXEMPT_DIRS, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";
import { NS_FORWARDER_SOURCE } from "./ns-forwarder-source.js";
import type { SandboxScope } from "./types.js";

/** The network a guarded cage gets. */
export interface BwrapNetwork {
  /** "namespace": an empty network namespace — nothing off the machine, and
   *  the host's loopback only through the bridge. "host": the host's own. */
  network: "namespace" | "host";
  /** With "namespace": the shell egress proxy's unix socket (bind-mounted into
   *  the cage) and its loopback port, which the in-cage forwarder listens on
   *  so the proxy URL in the shell's env is the same on both sides. Absent or
   *  missing on disk: the cage has no route out, which fails closed. */
  bridge?: { socketPath: string; port: number };
}

function isolatesNetwork(scope: SandboxScope, net: BwrapNetwork | undefined): boolean {
  return scope === "shell" || (scope === "guarded" && net?.network === "namespace");
}

function bridgeMounted(scope: SandboxScope, net: BwrapNetwork | undefined): { socketPath: string; port: number } | null {
  if (!isolatesNetwork(scope, net) || scope === "shell" || !net?.bridge) return null;
  return existsSync(net.bridge.socketPath) ? net.bridge : null;
}

// Shell rc files a confined shell must not be able to persist into. The
// launch-agent analog on Linux (~/.config/systemd/user, ~/.config/autostart)
// is already covered by the ~/.config entry in HOME_RELATIVE_DENY_DIRS.
const SHELL_RC_FILES = [
  ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv",
];

let bwrapPath: string | null | undefined;

/** Resolve once from the host environment before any child-specific env exists. */
export function resolveBwrapPath(pathEnv: string | undefined = process.env.PATH): string | null {
  if (pathEnv === process.env.PATH && bwrapPath !== undefined) return bwrapPath;
  if (process.platform !== "linux" || !pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "bwrap");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (pathEnv === process.env.PATH) bwrapPath = resolved;
      return resolved;
    } catch { /* keep searching */ }
  }
  if (pathEnv === process.env.PATH) bwrapPath = null;
  return null;
}

/** Linux with bwrap on PATH. Bwrap mode is a no-op everywhere else. */
export function isBwrapAvailable(): boolean {
  return resolveBwrapPath() !== null;
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
 * Build the bwrap argv that precedes the target + its args. `home` is
 * injectable for tests; defaults to the real home. Only emits --tmpfs /
 * --ro-bind entries for targets that exist — bwrap errors out on missing
 * targets, which would break every confined command.
 *
 * "shell" scope (phase A) confines agent shell children: --unshare-net, all
 * sensitive home dirs shadowed. "server" scope (phase B) confines the whole
 * Node server: network stays in the host namespace (the server's API egress
 * goes through the in-process canonicalFetch chokepoint) and the dirs the
 * server itself owns (~/.lax, ~/.codex) are not shadowed.
 */
export function generateBwrapArgs(home: string = homedir(), scope: SandboxScope = "shell", net?: BwrapNetwork): string[] {
  const realHome = canonical(home);
  const bridge = bridgeMounted(scope, net);

  const args = [
    "--bind", "/", "/",        // full host RW so the dev shell stays usable
    "--dev", "/dev",
    "--proc", "/proc",
    ...(isolatesNetwork(scope, net) ? ["--unshare-net"] : []), // empty network namespace
    // The proxy's unix socket is the one thing that crosses the namespace wall.
    ...(bridge ? ["--bind", bridge.socketPath, bridge.socketPath] : []),
    "--die-with-parent",       // caller's kill/timeout reaches the confined child
  ];

  const exemptDirs =
    scope === "server" ? SERVER_SCOPE_EXEMPT_DIRS :
    scope === "guarded" ? GUARDED_SCOPE_EXEMPT_DIRS :
    new Set<string>();
  const denyDirs = HOME_RELATIVE_DENY_DIRS.filter((d) => !exemptDirs.has(d));
  for (const dir of denyDirs) {
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
  scope: SandboxScope = "shell",
  net?: BwrapNetwork,
): { cmd: string; args: string[] } {
  const executable = resolveBwrapPath();
  if (!executable) return { cmd: shell, args: shellArgs };
  const bridge = bridgeMounted(scope, net);
  // With a bridge the first process in the cage is the forwarder, which
  // listens on the proxy's port inside the namespace and then runs the shell
  // with stdio and signals passed through (ns-forwarder-source.ts).
  const target = bridge
    ? [process.execPath, "-e", NS_FORWARDER_SOURCE, "--", bridge.socketPath, String(bridge.port), "--", shell, ...shellArgs]
    : [shell, ...shellArgs];
  return { cmd: executable, args: [...generateBwrapArgs(home, scope, net), ...target] };
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
      resolveBwrapPath()!,
      [...generateBwrapArgs(home), "/bin/bash", "-c", probe],
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.includes("RAN") && out.includes("NET-BLOCKED");
  } catch {
    return false;
  }
}

/**
 * Self-check for the SERVER-scope cage: can bwrap build these namespaces and
 * exec a target at all on this kernel? No network assertion — server scope
 * keeps the host network namespace by design; the tmpfs/ro-bind shadowing is
 * structural once the cage builds. Used by server-confine to fail open into
 * an unconfined boot (with a loud warning) instead of bricking startup on
 * hosts where unprivileged userns is disabled.
 */
export function bwrapServerCageRuns(home?: string): boolean {
  if (!isBwrapAvailable()) return false;
  try {
    const out = execFileSync(
      resolveBwrapPath()!,
      [...generateBwrapArgs(home, "server"), "/bin/sh", "-c", "echo RAN"],
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.includes("RAN");
  } catch {
    return false;
  }
}

/**
 * Self-check for the GUARDED-scope cage (the default shell posture): can bwrap
 * build these namespaces and exec a target on this kernel, and does an empty
 * network namespace actually deny the network (TEST-NET-1, unroutable)? Used
 * by the mode resolver to decide whether "guarded" is usable here or must fall
 * back to host (e.g. unprivileged userns disabled). The bridge is not probed:
 * it does not exist before the proxy starts, and its absence fails closed.
 */
export function bwrapGuardedRuns(home?: string): boolean {
  if (!isBwrapAvailable()) return false;
  const probe = "exec 3<>/dev/tcp/192.0.2.1/80 && echo NET-OK || echo NET-BLOCKED; echo RAN";
  try {
    const out = execFileSync(
      resolveBwrapPath()!,
      [...generateBwrapArgs(home, "guarded", { network: "namespace" }), "/bin/bash", "-c", probe],
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.includes("RAN") && out.includes("NET-BLOCKED");
  } catch {
    return false;
  }
}
