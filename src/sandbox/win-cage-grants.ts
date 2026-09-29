// Grants: what the caged shell may touch. Split from win-cage.ts (400-LOC cap).
//
// The sandbox user sees nothing under the real user's profile, and LAX's
// own tooling lives there: the portable Git it ships as the shell, the node
// it runs on, its own code (NODE_PATH points at it). Without read access to
// those, the cage refuses to start bash at all (2026-09-28, the first live
// run). So, once per process: read grants on those roots when they are under
// the profile, a write grant on the workspace, refcounted by the helper under
// this pid and revoked at exit.

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { workspaceRoot } from "../config.js";
import { createLogger } from "../logger.js";
import { resolveWinCageHelper, runHelper, underUserProfile, winCageStatus } from "./win-cage.js";

const logger = createLogger("sandbox.win-cage");

/** The install root a shell lives in: `…/PortableGit/bin/bash.exe` → `…/PortableGit`. */
function shellInstallRoot(shell: string): string {
  const dir = dirname(resolve(shell));
  return basename(dir).toLowerCase() === "bin" ? dirname(dir) : dir;
}

/** Directories the caged shell must read that sit under the real user's
 *  profile, deduplicated (a root covers its subpaths). Elsewhere is readable. */
export function winCageReadGrants(shell: string, execPath = process.execPath, projectRoot = process.cwd(), home = homedir()): string[] {
  const out: string[] = [];
  for (const candidate of [shellInstallRoot(shell), dirname(resolve(execPath)), resolve(projectRoot)]) {
    if (!underUserProfile(candidate, home)) continue;
    const c = candidate.toLowerCase();
    if (out.some((o) => c === o.toLowerCase() || c.startsWith(o.toLowerCase() + sep))) continue;
    out.push(candidate);
  }
  return out;
}

const granted = { read: new Set<string>(), write: new Set<string>() };
let revokeRegistered = false;
let sandboxSid: string | null = null;

function grantsNeeded(shell: string): { read: string[]; write: string[] } | null {
  const read = winCageReadGrants(shell).filter((p) => !granted.read.has(p));
  const write = [workspaceRoot()].filter((p) => !granted.write.has(p));
  return read.length === 0 && write.length === 0 ? null : { read, write };
}

function grantTarget(): { helper: string; sid: string } | null {
  if (sandboxSid) {
    const helper = resolveWinCageHelper();
    return helper ? { helper, sid: sandboxSid } : null;
  }
  const status = winCageStatus();
  if (!status.helper || !status.userSid) return null;
  sandboxSid = status.userSid;
  return { helper: status.helper, sid: status.userSid };
}

function recordGranted(req: { read: string[]; write: string[] }, helper: string, sid: string): void {
  for (const p of req.read) granted.read.add(p);
  for (const p of req.write) granted.write.add(p);
  if (revokeRegistered) return;
  revokeRegistered = true;
  process.once("exit", () => {
    try { execFileSync(helper, ["acl", "revoke", "--holder-pid", String(process.pid), "--sandbox-user-sid", sid], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); } catch { /* the helper prunes dead holders on its next acl op */ }
  });
}

/** Grant what `shell` needs, off the event loop. Called before the bash tool spawns. */
export async function ensureWinCageGrants(shell: string): Promise<void> {
  const req = grantsNeeded(shell);
  if (!req) return;
  const target = grantTarget();
  if (!target) return;
  const outcome = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = execFile(target.helper, ["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", target.sid], { windowsHide: true, timeout: 30_000, encoding: "utf-8" },
      (error, _stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stderr: String(stderr ?? "") }));
    child.stdin?.end(JSON.stringify(req));
  });
  if (outcome.code !== 0) {
    logger.warn(`[win-cage] grant failed (exit ${outcome.code}): ${outcome.stderr.trim().split("\n")[0]}`);
    return;
  }
  recordGranted(req, target.helper, target.sid);
}

/** The same, blocking — for the one spawn path that cannot await
 *  (process_start). A no-op once the bash tool has warmed the grants. */
export function ensureWinCageGrantsSync(shell: string): void {
  const req = grantsNeeded(shell);
  if (!req) return;
  const target = grantTarget();
  if (!target) return;
  const r = runHelper(target.helper, ["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", target.sid], { input: JSON.stringify(req), timeoutMs: 30_000 });
  if (r.code !== 0) {
    logger.warn(`[win-cage] grant failed (exit ${r.code}): ${r.stderr.trim().split("\n")[0]}`);
    return;
  }
  recordGranted(req, target.helper, target.sid);
}

