// Sandbox config validator. Pure functions, no side effects, no I/O beyond
// reading homedir() and the LAX_REPO_ROOT env var.
//
// extraMounts is the soft underbelly of SandboxConfig: a caller can pass
// `["~/.ssh:/root/.ssh"]` and the container would read host credentials.
// validateSandboxConfig() rejects sensitive bind sources before docker is
// invoked, so future config drift or plugin-driven mount-passing can't punch
// through the hardened defaults in execInSandbox().

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, sep as pathSep, posix as posixPath, win32 as win32Path } from "node:path";

import type { SandboxConfig } from "./sandbox-types.js";

// Home-relative directory prefixes that must not be mounted into the sandbox.
// Each entry is a path relative to homedir() — match is "equal or inside".
const HOME_RELATIVE_DENY_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  ".docker",
  ".kube",
  ".lax",
  ".sax",
  ".codex",
];

// Home-relative files that must not be mounted (exact match against resolved path).
const HOME_RELATIVE_DENY_FILES = [
  ".npmrc",
  ".pypirc",
  ".netrc",
];

// Absolute path prefixes that must not be mounted. "Equal or inside" semantics.
const ABSOLUTE_DENY_DIRS = [
  "/etc/sudoers.d",
  "/root",
];

// Absolute exact-match paths.
const ABSOLUTE_DENY_FILES = [
  "/etc/shadow",
  "/etc/sudoers",
];

// Path segments that flag a mount source as sensitive when any segment matches
// exactly (case-insensitive). Segment-exact, not substring, so a directory
// literally named "secrets" trips but `/var/log/credentialserver.log` does not.
const DENY_SEGMENT_NAMES = new Set(["secrets", "credentials", "keys", "tokens"]);

// File suffixes that flag a mount source as sensitive (case-insensitive).
const DENY_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

// Parse the host source out of a docker -v style mount spec. Returns the
// substring before the first ":" that isn't part of a Windows drive letter
// (so `C:\Users\me:/x` parses as source `C:\Users\me`).
function parseMountSource(mount: string): string {
  if (mount.length >= 2 && /^[A-Za-z]:$/.test(mount.slice(0, 2))) {
    // Windows drive letter — find the next colon after position 2.
    const next = mount.indexOf(":", 2);
    return next === -1 ? mount : mount.slice(0, next);
  }
  const idx = mount.indexOf(":");
  return idx === -1 ? mount : mount.slice(0, idx);
}

// Expand a leading "~" to the user's homedir. Returns the expanded string
// before any platform-specific path resolution, so callers can also inspect
// the raw POSIX form (important on Windows where path.resolve mangles "/etc/x").
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

// True if `child` equals `parent` or is nested inside it. Cross-platform.
function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(pathSep) ? parent : parent + pathSep;
  if (child.startsWith(withSep)) return true;
  // Also handle the case where caller passed a POSIX-style absolute path on
  // Windows (resolvePath normalizes most of this, but be defensive at the boundary).
  const posixParent = parent.split(win32Path.sep).join(posixPath.sep);
  const posixChild = child.split(win32Path.sep).join(posixPath.sep);
  if (posixChild === posixParent) return true;
  const posixWithSep = posixParent.endsWith(posixPath.sep) ? posixParent : posixParent + posixPath.sep;
  return posixChild.startsWith(posixWithSep);
}

function splitSegments(p: string): string[] {
  // Split on both separators so we catch Windows paths even if path.sep is "/".
  return p.split(/[\\/]/).filter(Boolean);
}

function getRepoRoot(): string {
  const env = process.env.LAX_REPO_ROOT;
  return resolvePath(env && env.trim().length > 0 ? env : process.cwd());
}

// True if `child` is `parent` or inside it, using POSIX path semantics.
// Used to catch literal POSIX denies (e.g., "/etc/shadow") regardless of host.
function isPosixPathInside(child: string, parent: string): boolean {
  const c = posixPath.normalize(child);
  const p = posixPath.normalize(parent);
  if (c === p) return true;
  const withSep = p.endsWith("/") ? p : p + "/";
  return c.startsWith(withSep);
}

// Returns reason string if the given path is in the deny list, or null if clean.
// `absPath` is the platform-resolved absolute path; `rawExpanded` is the
// tilde-expanded source string without platform resolution (so on Windows we
// can still catch a literal "/etc/shadow" intended for the Linux container).
function denyReasonForPath(absPath: string, rawExpanded: string): string | null {
  const home = resolvePath(homedir());

  if (absPath === home) return `path is the user home directory (${absPath})`;

  // Home-relative deny dirs.
  for (const rel of HOME_RELATIVE_DENY_DIRS) {
    const denied = resolvePath(home, rel);
    if (isPathInside(absPath, denied)) {
      return `path is inside ~/${rel} (${absPath})`;
    }
  }

  // Home-relative deny files (exact match).
  for (const rel of HOME_RELATIVE_DENY_FILES) {
    const denied = resolvePath(home, rel);
    if (absPath === denied) {
      return `path is ~/${rel} (${absPath})`;
    }
  }

  // Absolute deny dirs. Check both the platform-resolved path and the raw
  // (POSIX-literal) form — a Linux mount source like "/root/x" should be
  // rejected even when validating from a Windows host.
  for (const denied of ABSOLUTE_DENY_DIRS) {
    if (isPathInside(absPath, denied) || isPosixPathInside(rawExpanded, denied)) {
      return `path is inside ${denied} (${absPath})`;
    }
  }

  // Absolute deny files — same dual check.
  for (const denied of ABSOLUTE_DENY_FILES) {
    if (absPath === denied || posixPath.normalize(rawExpanded) === denied) {
      return `path is ${denied}`;
    }
  }

  // Repo root — mounting LAX's own source into the sandbox would expose the
  // agent's code (and any local config files) to whatever runs in the container.
  const repoRoot = getRepoRoot();
  if (isPathInside(absPath, repoRoot)) {
    return `path is inside the LAX repo root (${absPath})`;
  }

  // Segment-exact deny names (secrets/credentials/keys/tokens).
  for (const seg of splitSegments(absPath)) {
    if (DENY_SEGMENT_NAMES.has(seg.toLowerCase())) {
      return `path contains sensitive segment "${seg}" (${absPath})`;
    }
  }

  // Suffix deny (.pem, .key, .p12, .pfx).
  const lower = absPath.toLowerCase();
  for (const suffix of DENY_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return `path ends in ${suffix} (${absPath})`;
    }
  }

  // NOTE: Windows-specific sensitive paths (C:\Windows\System32\config,
  // %APPDATA%\Microsoft\Crypto) are not enumerated here. Docker Desktop on
  // Windows already refuses to bind-mount most of those, and the deny rules
  // above (home dir, repo root, segment-exact "secrets/keys", suffix .pfx/.p12)
  // catch the common credential-leak shapes on Windows. Revisit if a concrete
  // bypass surfaces.

  return null;
}

/**
 * Validate a SandboxConfig before docker is invoked.
 *
 * Pure function. Returns a structured result so callers can decide how to
 * surface (stderr, log, throw). Rules:
 *  - Every extraMount source must not resolve to a credential-bearing path
 *    (~/.ssh, ~/.aws, /etc/shadow, anything ending in .pem, etc.).
 *  - If networkEnabled=true, extraMounts must be empty-or-clean — defense in
 *    depth so a sensitive mount that somehow slipped past can't exfiltrate.
 *  - workspacePath must not resolve to homedir, repo root, "/", or any
 *    deny-listed path.
 */
export function validateSandboxConfig(
  cfg: SandboxConfig,
): { ok: true } | { ok: false; reason: string } {
  // 2a. extraMounts source-path deny list.
  for (const mount of cfg.extraMounts) {
    if (typeof mount !== "string" || mount.length === 0) {
      return { ok: false, reason: `extraMount must be a non-empty string (got ${JSON.stringify(mount)})` };
    }
    const source = parseMountSource(mount);
    if (source.length === 0) {
      return { ok: false, reason: `extraMount has empty source: ${JSON.stringify(mount)}` };
    }
    const rawExpanded = expandTilde(source);
    const abs = resolvePath(rawExpanded);

    // First pass: literal-path deny check against the unfollowed path. Catches
    // a Linux container source like "/etc/shadow" handed in from a Windows host
    // (where the path doesn't exist locally and realpath would just fail).
    const reason = denyReasonForPath(abs, rawExpanded);
    if (reason) {
      return { ok: false, reason: `extraMount source rejected: ${reason}` };
    }

    // Second pass: follow symlinks. Docker resolves symlinks at bind-mount
    // time, so a source that looks safe (`/tmp/innocent`) but actually points
    // at `/etc/shadow` would expose the linked target inside the container.
    // The validator's promise is "this path is safe to mount" — that has to
    // hold against the realpath, not just the lexical form.
    let realPath: string;
    try {
      realPath = realpathSync(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { ok: false, reason: `extraMount source does not exist: ${abs}` };
      }
      return { ok: false, reason: `extraMount source could not be resolved: ${abs} (${code ?? (err as Error)?.message ?? "unknown error"})` };
    }
    if (realPath !== abs) {
      const realReason = denyReasonForPath(realPath, realPath);
      if (realReason) {
        return { ok: false, reason: `extraMount source rejected after symlink resolution: ${realReason}` };
      }
    }
  }

  // 2b. Network override lock — if network is on, no extraMounts at all.
  // Even if every mount above passed the per-path check, network-on + any
  // bind-mount is enough leverage that we require a clean baseline.
  if (cfg.networkEnabled && cfg.extraMounts.length > 0) {
    return {
      ok: false,
      reason: `networkEnabled=true is incompatible with extraMounts (defense in depth)`,
    };
  }

  // 2c. Workspace path sanity.
  if (typeof cfg.workspacePath !== "string" || cfg.workspacePath.length === 0) {
    return { ok: false, reason: `workspacePath must be a non-empty string` };
  }
  const wsRaw = expandTilde(cfg.workspacePath);
  const wsAbs = resolvePath(wsRaw);
  if (wsAbs === "/" || /^[A-Za-z]:\\?$/.test(wsAbs) || posixPath.normalize(wsRaw) === "/") {
    return { ok: false, reason: `workspacePath cannot be the filesystem root (${wsAbs})` };
  }
  const wsReason = denyReasonForPath(wsAbs, wsRaw);
  if (wsReason) {
    return { ok: false, reason: `workspacePath rejected: ${wsReason}` };
  }

  return { ok: true };
}
