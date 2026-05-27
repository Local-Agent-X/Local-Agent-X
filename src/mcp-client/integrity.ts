// MCP server binary integrity check.
//
// On every connect, we resolve the MCP server's command to an absolute
// path, hash the binary, and compare against the first-trusted hash for
// that server name. If the hash drifts, refuse the spawn — supply-chain
// swaps, malicious updates, and PATH evil-twins all fall out the same
// loud failure mode. Operator escape hatches:
//   - delete the entry from <laxDir>/mcp-trust.json to re-trust on next run
//   - set LAX_MCP_RETRUST=<serverName> for a single-shot accept
//   - set LAX_MCP_STRICT_TRUST=1 to require manual trust-store seeding
//     (default behavior auto-trusts on first run since most users won't
//     pre-seed)

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute, sep, delimiter } from "node:path";
import { createLogger } from "../logger.js";
import { getLaxDir } from "../lax-data-dir.js";

const logger = createLogger("mcp-integrity");

// Cap binary reads at 4MB. A real binary swap will diverge well within
// the first 4MB (typically within the first few KB at the header).
// Full-file hashing would slow MCP server startup proportional to
// binary size for no security gain against the swap threat model.
const HASH_READ_CAP_BYTES = 4 * 1024 * 1024;

const TRUST_STORE_FILENAME = "mcp-trust.json";

export interface TrustEntry {
  sha256: string;
  firstSeenAt: number;
  commandPath: string;
}

export type TrustStore = Record<string, TrustEntry>;

export type VerifyResult =
  | { ok: true; firstTrust: boolean; sha256: string; resolvedPath: string }
  | { ok: false; reason: string; userHint: string };

function trustStorePath(): string {
  return join(getLaxDir(), TRUST_STORE_FILENAME);
}

/**
 * Resolve `command` to an absolute existing file path.
 * - Absolute path → return it iff the file exists, else null.
 * - Relative/bare name → walk PATH, on Windows also try each PATHEXT
 *   extension. Returns the first match found.
 */
export function resolveCommandPath(command: string): string | null {
  if (!command) return null;

  if (isAbsolute(command)) {
    return fileExists(command) ? command : null;
  }

  const isWindows = process.platform === "win32";
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return null;

  const dirs = pathEnv.split(delimiter).filter(d => d.length > 0);

  // On Windows, also append `.` so a bare name resolves against the cwd
  // when PATHEXT extension match succeeds — matches cmd.exe semantics.
  // We deliberately do NOT do this on POSIX; that would surprise users.
  const candidateDirs = isWindows ? [...dirs, "."] : dirs;

  const extensions = isWindows
    ? buildWindowsExtensions(command)
    : [""];

  for (const dir of candidateDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function buildWindowsExtensions(command: string): string[] {
  // If the command already has an extension, try it as-is FIRST, then
  // fall through to PATHEXT — matches how Windows resolves `node` vs
  // `node.exe`.
  const lower = command.toLowerCase();
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const hasExt = pathext.some(ext => lower.endsWith(ext.toLowerCase()));
  if (hasExt) {
    return ["", ...pathext];
  }
  return ["", ...pathext];
}

function fileExists(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * SHA-256 of the first 4MB of the binary. The cap is intentional — see
 * HASH_READ_CAP_BYTES note above. Any meaningful swap diverges far
 * inside the cap window; full-file hashing would add latency on every
 * MCP connect without strengthening the threat model.
 */
export function hashCommandBinary(absPath: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  let fd = -1;
  try {
    fd = openSync(absPath, "r");
    let totalRead = 0;
    while (totalRead < HASH_READ_CAP_BYTES) {
      const want = Math.min(buf.length, HASH_READ_CAP_BYTES - totalRead);
      const n = readSync(fd, buf, 0, want, totalRead);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      totalRead += n;
    }
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
  return hash.digest("hex");
}

export function loadTrustStore(): TrustStore {
  const p = trustStorePath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TrustStore;
    }
    logger.warn(`mcp-trust: ${p} is not an object, treating as empty`);
    return {};
  } catch (e) {
    logger.warn(`mcp-trust: failed to read ${p}: ${(e as Error).message}`);
    return {};
  }
}

export function saveTrustStore(store: TrustStore): void {
  const dir = getLaxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const target = trustStorePath();
  const tmp = `${target}.tmp.${process.pid}`;
  const body = JSON.stringify(store, null, 2);
  writeFileSync(tmp, body, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
  // rename preserves the tmp's mode on POSIX; on Windows mode bits are
  // largely advisory. Re-apply 0o600 defensively in case the rename
  // crossed a filesystem boundary that altered perms.
  if (process.platform !== "win32") {
    try { chmodSync(target, 0o600); } catch { /* best-effort */ }
  }
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Verify the MCP server's binary against the trust store. Returns a
 * tagged result so the caller (connection.connect) can refuse the spawn
 * with a precise error and user-facing hint when integrity fails.
 */
export function verifyOrTrust(
  serverName: string,
  configCommand: string,
  opts?: { allowAutoTrust?: boolean },
): VerifyResult {
  const resolvedPath = resolveCommandPath(configCommand);
  if (!resolvedPath) {
    return {
      ok: false,
      reason: "command not found on PATH",
      userHint: `check the MCPServerConfig.command "${configCommand}" for typos or install the binary.`,
    };
  }

  const sha256 = hashCommandBinary(resolvedPath);
  const store = loadTrustStore();
  const existing = store[serverName];

  if (!existing) {
    const strict = envFlag("LAX_MCP_STRICT_TRUST");
    const allowAuto = opts?.allowAutoTrust !== false && !strict;
    if (!allowAuto) {
      return {
        ok: false,
        reason: "server not in trust store and strict-trust mode is on",
        userHint: `add "${serverName}" to ${trustStorePath()} manually, or unset LAX_MCP_STRICT_TRUST to auto-trust on first run.`,
      };
    }
    store[serverName] = {
      sha256,
      firstSeenAt: Date.now(),
      commandPath: resolvedPath,
    };
    saveTrustStore(store);
    return { ok: true, firstTrust: true, sha256, resolvedPath };
  }

  if (existing.sha256 === sha256) {
    return { ok: true, firstTrust: false, sha256, resolvedPath };
  }

  // Hash mismatch. Allow a single-shot re-trust via LAX_MCP_RETRUST.
  if (process.env.LAX_MCP_RETRUST === serverName) {
    logger.warn(`mcp-trust: re-trusting "${serverName}" (LAX_MCP_RETRUST set). old=${existing.sha256.slice(0, 12)} new=${sha256.slice(0, 12)}`);
    store[serverName] = {
      sha256,
      firstSeenAt: Date.now(),
      commandPath: resolvedPath,
    };
    saveTrustStore(store);
    return { ok: true, firstTrust: false, sha256, resolvedPath };
  }

  return {
    ok: false,
    reason: `${serverName} binary hash changed since first trust`,
    userHint: `if you upgraded the server intentionally, delete the entry from ${trustStorePath()} or set LAX_MCP_RETRUST=${serverName} and reconnect. otherwise investigate — this may indicate a compromised binary.`,
  };
}

// Test-only export: lets the test suite locate the trust store file
// without re-deriving the path from getLaxDir().
export function __trustStorePathForTests(): string {
  return trustStorePath();
}

// Test-only export: cap value, so the 4MB-cap test asserts against the
// exact module constant instead of duplicating the magic number.
export const __HASH_READ_CAP_BYTES_FOR_TESTS = HASH_READ_CAP_BYTES;
