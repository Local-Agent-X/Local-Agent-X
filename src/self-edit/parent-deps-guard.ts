/**
 * Parent node_modules integrity guard for the self_edit sandbox.
 *
 * The sandbox junctions the parent repo's REAL node_modules into the worktree
 * so the build resolves deps without a per-shift install. The subprocess is
 * told (in prompt.ts) NOT to run installs — but if it disobeys and runs
 * `npm install`, the write goes straight through the junction into the parent's
 * real deps, before the deps gate (which only isolates AFTER the subprocess
 * finishes) can react. That can prune @arikernel/@esbuild and brick the app.
 *
 * Invariant we enforce: the parent's node_modules is UNCHANGED across the whole
 * self_edit. The only legitimate install (the deps gate) runs isolated inside
 * the worktree, never the parent. So any change to the parent fingerprint during
 * the subprocess run means the contract was violated. We detect it cheaply (a
 * few stats, no tree walk), restore the parent deterministically via `npm ci`,
 * and let the caller abort — code produced under a violated sandbox contract
 * isn't trustworthy.
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";
import { npmAugmentedEnv } from "../anthropic-client/cli-path.js";

const logger = createLogger("self-edit.parent-deps");

// Cheap, high-signal sentinels. .package-lock.json is npm's install record —
// rewritten on every install/ci/prune. The package count catches prunes; the
// critical-package sentinels catch deletion of deps that brick build/boot.
const SENTINELS = [".package-lock.json", "typescript/package.json", "@arikernel/core/package.json", "@esbuild"];

/** Fingerprint the parent node_modules without walking the tree. Returns null
 *  when there is no node_modules to guard (nothing to protect). */
export function fingerprintParentDeps(repoRoot: string): string | null {
  const nm = join(repoRoot, "node_modules");
  let topCount: number;
  try { topCount = readdirSync(nm).length; } catch { return null; }
  const parts: string[] = [`count:${topCount}`];
  for (const s of SENTINELS) {
    try { const st = statSync(join(nm, s)); parts.push(`${s}:${st.size}:${Math.round(st.mtimeMs)}`); }
    catch { parts.push(`${s}:MISSING`); }
  }
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Deterministically restore the parent's node_modules from the lockfile.
 *  Only invoked on the (rare) corruption path. */
export function restoreParentDeps(repoRoot: string): { ok: boolean; detail: string } {
  try {
    execSync("npm ci", { cwd: repoRoot, timeout: 5 * 60_000, stdio: "pipe", env: npmAugmentedEnv(), windowsHide: true });
    return { ok: true, detail: "npm ci restored parent node_modules" };
  } catch (e) {
    logger.error(`[self-edit.parent-deps] npm ci restore failed: ${(e as Error).message}`);
    return { ok: false, detail: (e as Error).message.slice(0, 400) };
  }
}
