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
export function enforceStartupIntegrity(): void {
  // self_edit's bind-probe sets this to skip the integrity check —
  // the probe is short-lived (a few seconds, just verifies port bind +
  // auth route answers), so a missing arikernel file shouldn't kill it
  // even though it would kill a real boot. The parent server still
  // enforces integrity normally; this only loosens it for probes.
  if (process.env.LAX_SKIP_INTEGRITY === "1") return;
  const result = checkStartupIntegrity();
  if (result.ok) return;

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
