// Single source of truth for "check for an update" and "apply an update".
// Lifted out of routes/settings/system.ts so the HTTP route AND the agent tools
// (check_for_updates / apply_update) share one implementation — no fork.
//
// Both install shapes are handled: a git checkout (local `git fetch` + behind
// count, works for private repos via the user's credential helper) and a
// rolling/tarball install (OTAManager: last-installed commit vs remote main).
// Apply routes through update-pipeline's validated swap (deps/build/bind/smoke
// gates) — nothing overwrites the live install until the candidate passes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeErrorMessage } from "./server-utils.js";

export interface UpdateCheckResult {
  localVersion: string;
  localCommit: string;
  remoteVersion: string;
  remoteCommit: string;
  updateAvailable: boolean;
  releaseNotes: string;
  rolling?: boolean;
  cached?: boolean;
  error?: string;
}

export interface ApplyUpdateResult {
  ok: boolean;
  held?: boolean;
  fromCommit: string;
  toCommit: string;
  detail: string;
  rolling?: boolean;
}

let _updateCache: { data: UpdateCheckResult; time: number } | null = null;
export function bustUpdateCache(): void { _updateCache = null; }

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  try {
    const { execSync } = await import("node:child_process");
    const repoRoot = process.cwd();
    const localPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version?: string };
    const localVersion = localPkg.version || "0.0.0";

    let localCommit = "";
    try { localCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim(); }
    catch {
      // Not a git checkout (rolling/tarball) — compare last-installed commit to
      // remote main HEAD. First check before any in-app update has no recorded
      // commit, so optimistically report an update is available.
      try {
        const { OTAManager } = await import("./ota-update.js");
        const ota = new OTAManager();
        const installed = await ota.readInstalledCommit();
        const { commit, subject } = await ota.checkMainCommit();
        return {
          localVersion,
          localCommit: installed ? installed.slice(0, 7) : "",
          remoteVersion: localVersion,
          remoteCommit: commit.slice(0, 7),
          updateAvailable: installed ? installed !== commit : true,
          releaseNotes: subject,
          rolling: true,
        };
      } catch (e) {
        return { localVersion, localCommit: "", remoteVersion: localVersion, remoteCommit: "", updateAvailable: false, releaseNotes: "", error: safeErrorMessage(e) };
      }
    }

    const now = Date.now();
    if (!force && _updateCache && now - _updateCache.time < 300000) {
      return { ..._updateCache.data, localVersion, localCommit, cached: true };
    }

    let remoteVersion = localVersion, remoteCommit = "", updateAvailable = false, releaseNotes = "", checkError: string | undefined;
    try {
      execSync("git fetch origin main --quiet", { cwd: repoRoot, encoding: "utf-8", timeout: 30000 });
      remoteCommit = execSync("git rev-parse --short origin/main", { cwd: repoRoot, encoding: "utf-8" }).trim();
      try {
        const remotePkgRaw = execSync("git show origin/main:package.json", { cwd: repoRoot, encoding: "utf-8" });
        remoteVersion = (JSON.parse(remotePkgRaw) as { version?: string }).version || localVersion;
      } catch { /* remote package.json may be missing — keep localVersion */ }
      try { releaseNotes = execSync("git log -1 --format=%s origin/main", { cwd: repoRoot, encoding: "utf-8" }).trim(); } catch { /* non-fatal */ }
      // "Behind", not "different": a developer_mode install carries local commits,
      // so an update exists only when origin/main has commits this install lacks.
      const behind = parseInt(execSync("git rev-list --count HEAD..origin/main", { cwd: repoRoot, encoding: "utf-8" }).trim(), 10) || 0;
      updateAvailable = behind > 0;
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() || "";
      checkError = (stderr || err.message).trim().split("\n")[0] || "git fetch failed";
    }

    const result: UpdateCheckResult = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes, ...(checkError ? { error: checkError } : {}) };
    if (!checkError) _updateCache = { data: result, time: now };
    return result;
  } catch (e) {
    return { localVersion: "0.0.0", localCommit: "", remoteVersion: "0.0.0", remoteCommit: "", updateAvailable: false, releaseNotes: "", error: safeErrorMessage(e) };
  }
}

/**
 * Download + validate + apply the available update. Returns ok=false (with
 * detail) on validation failure, held=true if another self-edit/update holds
 * the machine lock. Does NOT restart — the caller decides (the route tells the
 * browser user to restart; apply_update triggers a relaunch).
 */
export async function applyUpdateNow(): Promise<ApplyUpdateResult> {
  const { execSync } = await import("node:child_process");
  const { getRuntimeConfig } = await import("./config.js");
  const repoRoot = process.cwd();
  const authToken = getRuntimeConfig().authToken;
  bustUpdateCache();

  let isGitCheckout = true;
  try { execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }); } catch { isGitCheckout = false; }

  if (!isGitCheckout) {
    const { applyRollingUpdate } = await import("./update-pipeline.js");
    const r = await applyRollingUpdate(repoRoot, authToken);
    return { ok: r.ok, held: r.held, fromCommit: r.fromCommit, toCommit: r.toCommit, detail: r.detail, rolling: true };
  }
  const { applyGitUpdate } = await import("./update-pipeline.js");
  const r = await applyGitUpdate(repoRoot, authToken);
  return { ok: r.ok, held: r.held, fromCommit: r.fromCommit, toCommit: r.toCommit, detail: r.detail };
}
