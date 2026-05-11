/**
 * Startup integrity check — fast-fail at boot if critical files that
 * git knows about are missing from disk.
 *
 * Specifically motivated by: Windows Defender repeatedly quarantines
 * files in packages/arikernel/runtime/__tests__/ because the test
 * fixture filenames (now neutralized) used to match exfiltration
 * pattern signatures. When that happens, the server boots successfully
 * but crashes mid-conversation as soon as anything in arikernel is
 * exercised. This check turns the silent failure into a loud actionable
 * message at boot:
 *
 *   FILES MISSING — almost certainly Windows Defender / antivirus.
 *   Run: git checkout -- packages/arikernel/
 *
 * Cheap (single existsSync per sentinel, ~5ms total). No-op if all
 * sentinels exist. Aborts process with code 2 if any are missing so
 * the supervisor knows this is a fatal config issue, not a transient
 * crash.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createLogger } from "./logger.js";
const logger = createLogger("startup-integrity");

/**
 * Files/directories that MUST exist for the server to function. If any
 * is missing, the server should refuse to start with a clear remediation
 * message. Add new sentinels here when adding new critical bundled
 * packages.
 */
const SENTINELS: Array<{ path: string; restoreHint: string }> = [
  // arikernel — most-frequently AV-eaten subtree
  { path: "packages/arikernel/runtime/src/index.ts", restoreHint: "git checkout -- packages/arikernel/" },
  { path: "packages/arikernel/core/src/index.ts", restoreHint: "git checkout -- packages/arikernel/" },
  { path: "packages/arikernel/runtime/dist/index.js", restoreHint: "npm install (rebuilds via postinstall)" },
];

export interface IntegrityResult {
  ok: boolean;
  missing: Array<{ path: string; restoreHint: string }>;
}

export function checkStartupIntegrity(repoRoot: string = process.cwd()): IntegrityResult {
  const missing: IntegrityResult["missing"] = [];
  for (const sentinel of SENTINELS) {
    const abs = join(repoRoot, sentinel.path);
    if (!existsSync(abs)) {
      missing.push(sentinel);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Top-level helper used by src/index.ts at boot. Either returns silently
 * (everything OK) or prints a red banner + exits with code 2.
 */
/**
 * Try to auto-restore missing files from git HEAD. Fires only when the
 * server boots with sentinel files missing — the AV-quarantine recovery
 * path. Idempotent: if `git checkout HEAD -- packages/arikernel/` brings
 * them back, the next integrity check passes and the server boots
 * normally. If git fails (no repo, no remote, files genuinely deleted
 * from history), we fall through to the banner + exit.
 *
 * Disabled by env: LAX_AUTO_RESTORE_INTEGRITY=0. Default: on, because
 * the failure mode this guards against (LAX won't boot until you
 * manually run git) is much worse than the auto-restore's worst case
 * (a stale local edit gets reverted — only happens to files in
 * packages/arikernel/, which the operator rarely edits by hand).
 */
function tryAutoRestore(missingPaths: string[]): { restored: boolean; error?: string } {
  if (process.env.LAX_AUTO_RESTORE_INTEGRITY === "0") return { restored: false, error: "disabled by env" };
  // Restrict the auto-restore to packages/arikernel/ — the known
  // AV-quarantine target. We don't want to silently restore arbitrary
  // missing files; that could mask real deletions in src/.
  const arikernelPaths = missingPaths.filter(p => p.startsWith("packages/arikernel/"));
  if (arikernelPaths.length === 0) return { restored: false, error: "no arikernel paths to restore" };
  try {
    execFileSync("git", ["checkout", "HEAD", "--", "packages/arikernel/"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (e) {
    return { restored: false, error: (e as Error).message };
  }
  // Verify the restore actually landed by re-running the integrity check.
  const after = checkStartupIntegrity();
  if (after.ok) return { restored: true };
  return { restored: false, error: `git restore ran but ${after.missing.length} file(s) still missing` };
}

export function enforceStartupIntegrity(): void {
  // self_edit's bind-probe sets this to skip the integrity check —
  // the probe is short-lived (a few seconds, just verifies port bind +
  // auth route answers), so a missing arikernel file shouldn't kill it
  // even though it would kill a real boot. The parent server still
  // enforces integrity normally; this only loosens it for probes.
  if (process.env.LAX_SKIP_INTEGRITY === "1") return;
  const result = checkStartupIntegrity();
  if (result.ok) return;

  // Antivirus self-heal — auto-restore from git HEAD when the missing
  // files are the known AV-quarantine target. Three AVs (Defender + AVG +
  // McAfee) competing on this machine eat packages/arikernel/ files at
  // unpredictable times, so a self-healing boot is much better UX than
  // the manual `git checkout` flow. See tryAutoRestore for the guardrails.
  const restore = tryAutoRestore(result.missing.map(m => m.path));
  if (restore.restored) {
    logger.warn(`[integrity] AV-quarantine self-heal: restored ${result.missing.length} file(s) from git HEAD. Configure AV exclusion for packages/arikernel/ to stop this from happening at boot.`);
    return;
  }

  // Build a single multi-line warning so it doesn't get scattered through
  // log levels. The supervisor + IDE both display the last few lines on
  // crash, so the action item must be at the bottom.
  const banner = [
    "",
    "═══════════════════════════════════════════════════════════════",
    "  STARTUP INTEGRITY CHECK FAILED — refusing to start.",
    "",
    "  Files git tracks are missing from disk. On Windows this is",
    "  almost certainly antivirus quarantine (Defender flags some of",
    "  the security test fixtures as malicious payloads).",
    "",
    "  Missing:",
    ...result.missing.map(m => `    - ${m.path}`),
    "",
    "  To restore (run from repo root):",
    ...[...new Set(result.missing.map(m => m.restoreHint))].map(h => `    $ ${h}`),
    "",
    "  After restoring, restart the server.",
    "═══════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
  logger.error(banner);
  process.exit(2);
}
