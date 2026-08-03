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
import { pathToFileURL } from "node:url";
import { safeErrorMessage } from "./server-utils.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "./local-only-policy.js";
import { gitSafeCmd } from "./git-safety.js";

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
  installedElectronVersion?: string;
  installedChromiumVersion?: string;
  requiredElectronVersion?: string;
  requiredChromiumVersion?: string;
  nativeUpdateRequired?: boolean;
  nativeInstallerUrl?: string;
  nativeRuntimeCheckError?: string;
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

const ROLLING_RUNTIME_MANIFEST_URL =
  "https://github.com/Local-Agent-X/Local-Agent-X/releases/download/rolling/runtime-manifest.json";

interface RollingRuntimeManifest {
  schemaVersion: 1;
  electronVersion: string;
  chromiumVersion: string;
}

function isDottedNumericVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)*$/.test(value);
}

export function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function parseRuntimeManifest(value: unknown): RollingRuntimeManifest {
  if (!value || typeof value !== "object") throw new Error("runtime manifest is not an object");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isDottedNumericVersion(candidate.electronVersion) ||
    !isDottedNumericVersion(candidate.chromiumVersion)
  ) {
    throw new Error("runtime manifest has an invalid shape");
  }
  return {
    schemaVersion: 1,
    electronVersion: candidate.electronVersion,
    chromiumVersion: candidate.chromiumVersion,
  };
}

function stableInstallerUrl(platform: NodeJS.Platform): string | undefined {
  const releaseRoot = "https://github.com/Local-Agent-X/Local-Agent-X/releases/download/rolling/";
  if (platform === "darwin") return `${releaseRoot}Install.Local.Agent.X.Mac.Installer.dmg`;
  if (platform === "win32") return `${releaseRoot}Install.Local.Agent.X.Windows.Installer.exe`;
  return undefined;
}

async function withNativeRuntimeCheck(result: UpdateCheckResult): Promise<UpdateCheckResult> {
  const installedElectronVersion = process.env.LAX_DESKTOP_ELECTRON_VERSION;
  const installedChromiumVersion = process.env.LAX_DESKTOP_CHROMIUM_VERSION;
  // The normal browser/server-only install has no native shell to upgrade.
  if (!installedElectronVersion) return result;

  const installed = {
    installedElectronVersion,
    ...(installedChromiumVersion ? { installedChromiumVersion } : {}),
  };
  try {
    if (!isDottedNumericVersion(installedElectronVersion)) {
      throw new Error("installed Electron version is invalid");
    }
    const response = await fetch(ROLLING_RUNTIME_MANIFEST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`runtime manifest request failed (${response.status})`);
    const manifest = parseRuntimeManifest(await response.json());
    return {
      ...result,
      ...installed,
      requiredElectronVersion: manifest.electronVersion,
      requiredChromiumVersion: manifest.chromiumVersion,
      nativeUpdateRequired: compareDottedVersions(installedElectronVersion, manifest.electronVersion) < 0,
      ...(stableInstallerUrl(process.platform) ? { nativeInstallerUrl: stableInstallerUrl(process.platform) } : {}),
    };
  } catch (error) {
    return {
      ...result,
      ...installed,
      nativeRuntimeCheckError: safeErrorMessage(error),
    };
  }
}

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  if (isLocalOnlyMode()) {
    return { localVersion: "0.0.0", localCommit: "", remoteVersion: "0.0.0", remoteCommit: "", updateAvailable: false, releaseNotes: "", error: LOCAL_ONLY_BLOCK_MESSAGE };
  }
  try {
    const { execSync } = await import("node:child_process");
    const repoRoot = process.cwd();
    const localPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version?: string };
    const localVersion = localPkg.version || "0.0.0";

    let localCommit = "";
    try { localCommit = execSync(gitSafeCmd("git rev-parse --short HEAD"), { cwd: repoRoot, encoding: "utf-8" }).trim(); }
    catch {
      // Not a git checkout (rolling/tarball) — compare last-installed commit to
      // remote main HEAD. First check before any in-app update has no recorded
      // commit, so optimistically report an update is available.
      try {
        const { OTAManager } = await import("./ota-update.js");
        const ota = new OTAManager();
        const installed = await ota.readInstalledCommit();
        const { commit, subject } = await ota.checkMainCommit();
        return await withNativeRuntimeCheck({
          localVersion,
          localCommit: installed ? installed.slice(0, 7) : "",
          remoteVersion: localVersion,
          remoteCommit: commit.slice(0, 7),
          updateAvailable: installed ? installed !== commit : true,
          releaseNotes: subject,
          rolling: true,
        });
      } catch (e) {
        return await withNativeRuntimeCheck({ localVersion, localCommit: "", remoteVersion: localVersion, remoteCommit: "", updateAvailable: false, releaseNotes: "", error: safeErrorMessage(e) });
      }
    }

    const now = Date.now();
    if (!force && _updateCache && now - _updateCache.time < 300000) {
      return { ..._updateCache.data, localVersion, localCommit, cached: true };
    }

    let remoteVersion = localVersion, remoteCommit = "", updateAvailable = false, releaseNotes = "", checkError: string | undefined;
    try {
      execSync(gitSafeCmd("git fetch origin main --quiet"), { cwd: repoRoot, encoding: "utf-8", timeout: 30000 });
      remoteCommit = execSync(gitSafeCmd("git rev-parse --short origin/main"), { cwd: repoRoot, encoding: "utf-8" }).trim();
      try {
        const remotePkgRaw = execSync(gitSafeCmd("git show origin/main:package.json"), { cwd: repoRoot, encoding: "utf-8" });
        remoteVersion = (JSON.parse(remotePkgRaw) as { version?: string }).version || localVersion;
      } catch { /* remote package.json may be missing — keep localVersion */ }
      try { releaseNotes = execSync(gitSafeCmd("git log -1 --format=%s origin/main"), { cwd: repoRoot, encoding: "utf-8" }).trim(); } catch { /* non-fatal */ }
      // "Behind", not "different": a developer_mode install carries local commits,
      // so an update exists only when origin/main has commits this install lacks.
      const behind = parseInt(execSync(gitSafeCmd("git rev-list --count HEAD..origin/main"), { cwd: repoRoot, encoding: "utf-8" }).trim(), 10) || 0;
      updateAvailable = behind > 0;
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() || "";
      checkError = (stderr || err.message).trim().split("\n")[0] || "git fetch failed";
    }

    const sourceResult: UpdateCheckResult = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes, ...(checkError ? { error: checkError } : {}) };
    const result = await withNativeRuntimeCheck(sourceResult);
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
  if (isLocalOnlyMode()) {
    return { ok: false, held: true, fromCommit: "", toCommit: "", detail: LOCAL_ONLY_BLOCK_MESSAGE };
  }
  const { execSync } = await import("node:child_process");
  const { getRuntimeConfig } = await import("./config.js");
  const repoRoot = process.cwd();
  const authToken = getRuntimeConfig().authToken;
  bustUpdateCache();

  let isGitCheckout = true;
  try { execSync(gitSafeCmd("git rev-parse --short HEAD"), { cwd: repoRoot, encoding: "utf-8" }); } catch { isGitCheckout = false; }

  if (!isGitCheckout) {
    const { applyRollingUpdate } = await import("./update-pipeline.js");
    const r = await applyRollingUpdate(repoRoot, authToken);
    if (r.ok) await reassertUninstallRegistration(repoRoot);
    return { ok: r.ok, held: r.held, fromCommit: r.fromCommit, toCommit: r.toCommit, detail: r.detail, rolling: true };
  }
  const { applyGitUpdate } = await import("./update-pipeline.js");
  const r = await applyGitUpdate(repoRoot, authToken);
  if (r.ok) await reassertUninstallRegistration(repoRoot);
  return { ok: r.ok, held: r.held, fromCommit: r.fromCommit, toCommit: r.toCommit, detail: r.detail };
}

/**
 * A rolling update replaces the install tree wholesale. Anything generated at
 * install time and left inside that tree does not survive — which is exactly
 * how the Add/Remove Programs entry used to break: its uninstaller script was
 * deleted by an update, leaving a Settings row that ran a missing file and so
 * did nothing at all, with no error the user could see. The version it
 * advertised went stale the same way.
 *
 * Re-asserting after every successful apply keeps the entry truthful and
 * re-stages the uninstaller, which lives outside the tree (in ~/.lax/uninstall)
 * so a future update cannot orphan it again.
 *
 * Deliberately swallows everything: a cosmetic Settings row must never be able
 * to fail an update that otherwise succeeded.
 */
async function reassertUninstallRegistration(repoRoot: string): Promise<void> {
  try {
    const modPath = join(repoRoot, "scripts", "installer", "uninstall-registration.mjs");
    const mod = await import(pathToFileURL(modPath).href);
    mod.assertUninstallRegistration({ sourceRoot: repoRoot });
  } catch { /* non-fatal by design — see above */ }
}
