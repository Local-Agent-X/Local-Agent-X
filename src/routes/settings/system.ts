import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../../server-utils.js";
import { getToolStats, getToolSuccessRate, getRecentFailures } from "../../tool-tracker.js";
import { getProviderHealthStatus } from "../../model-fallback.js";
import { getThreatDashboard } from "../../threat/threat-dashboard.js";

/** Typed cache for update check results stored on the module scope */
interface UpdateCheckResult { localVersion: string; localCommit: string; remoteVersion: string; remoteCommit: string; updateAvailable: boolean; releaseNotes: string; error?: string }
let _updateCache: { data: UpdateCheckResult; time: number } | null = null;

export const handleSystemRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Health
  if (method === "GET" && url.pathname === "/api/health") {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    json(200, {
      status: "ok", uptime: Math.round(uptime), version: "0.1.0",
      memory: { heapUsedMB: Math.round(mem.heapUsed / 1048576), heapTotalMB: Math.round(mem.heapTotal / 1048576), rssMB: Math.round(mem.rss / 1048576) },
      toolStats: getToolStats(),
    }); return true;
  }

  // System status
  if (method === "GET" && url.pathname === "/api/system-status") {
    const { getSandboxMode, isDockerAvailable } = await import("../../sandbox/index.js");
    const { loadProfileName } = await import("../../autonomy/profile-store.js");
    const threatData = getThreatDashboard();
    const providerHealth = getProviderHealthStatus();
    const tStats = getToolStats();
    json(200, {
      profile: ctx.config.profile, toolApproval: ctx.config.toolApproval,
      autonomyProfile: loadProfileName(),
      retentionDays: ctx.config.retentionDays, autoUpdate: ctx.config.autoUpdate, logLevel: ctx.config.logLevel,
      sandbox: { mode: getSandboxMode(), dockerAvailable: isDockerAvailable() },
      security: { threatsBlocked: threatData.stats?.totalBlocked || 0, threatLevel: threatData.currentThreatLevel || "normal", recentEvents: (threatData.recentEvents || []).slice(0, 5) },
      providers: providerHealth,
      tools: { totalCalls: Object.values(tStats).reduce((sum, t) => sum + (t.totalCalls || 0), 0), successRate: getToolSuccessRate(), recentFailures: getRecentFailures(5) },
      uptime: Math.floor(process.uptime()), memoryUsage: process.memoryUsage().heapUsed, nodeVersion: process.version,
    }); return true;
  }

  // Autonomy profile (Safe / Normal / Developer / Power / Autonomous).
  // Separate from /api/profile above, which is the deployment profile
  // (home / dev / enterprise) and lives in config.json.
  if (method === "GET" && url.pathname === "/api/autonomy/profile") {
    const { loadProfileName } = await import("../../autonomy/profile-store.js");
    const { PROFILE_NAMES } = await import("../../autonomy/profiles.js");
    json(200, { profile: loadProfileName(), available: PROFILE_NAMES }); return true;
  }
  if (method === "POST" && url.pathname === "/api/autonomy/profile") {
    const body = await readBody(req);
    const { profile } = JSON.parse(body);
    const { isProfileName } = await import("../../autonomy/profiles.js");
    if (!isProfileName(profile)) { json(400, { error: "Invalid profile" }); return true; }
    const { saveProfileName } = await import("../../autonomy/profile-store.js");
    saveProfileName(profile);
    json(200, { ok: true, profile }); return true;
  }

  // Rollback artifacts — list recent capture contracts and trigger undo.
  if (method === "GET" && url.pathname === "/api/rollback/list") {
    const { listRollbacks } = await import("../../autonomy/rollback.js");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    json(200, { entries: listRollbacks(limit) }); return true;
  }
  if (method === "POST" && url.pathname === "/api/rollback/undo") {
    const body = await readBody(req);
    const { toolCallId } = JSON.parse(body);
    if (typeof toolCallId !== "string" || !toolCallId) { json(400, { error: "toolCallId required" }); return true; }
    const { restoreRollback } = await import("../../autonomy/rollback.js");
    const result = restoreRollback(toolCallId);
    json(result.ok ? 200 : 400, result); return true;
  }

  // Profile switch
  if (method === "POST" && url.pathname === "/api/profile") {
    const body = await readBody(req);
    const { profile } = JSON.parse(body);
    if (!["home", "dev", "enterprise"].includes(profile)) { json(400, { error: "Invalid profile" }); return true; }
    const { PROFILE_DEFAULTS, saveConfig } = await import("../../config.js");
    const defaults = PROFILE_DEFAULTS[profile as keyof typeof PROFILE_DEFAULTS];
    ctx.config.profile = profile;
    ctx.config.toolApproval = defaults.toolApproval;
    ctx.config.retentionDays = defaults.retentionDays;
    ctx.config.autoUpdate = defaults.autoUpdate;
    ctx.config.logLevel = defaults.logLevel;
    saveConfig(ctx.config);
    json(200, { ok: true, profile, applied: defaults }); return true;
  }

  // Sandbox
  if (method === "GET" && url.pathname === "/api/sandbox") {
    const { getSandboxMode, isDockerAvailable } = await import("../../sandbox/index.js");
    json(200, { mode: getSandboxMode(), dockerAvailable: isDockerAvailable(), dockerDownloadUrl: "https://www.docker.com/products/docker-desktop/" }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sandbox") {
    const body = await readBody(req);
    const { mode } = JSON.parse(body);
    if (mode !== "host" && mode !== "docker") { json(400, { error: "Invalid mode" }); return true; }
    const { setSandboxMode } = await import("../../sandbox/index.js");
    const result = setSandboxMode(mode);
    json(result.ok ? 200 : 400, result); return true;
  }

  // Update checker — uses local git (not GitHub HTTP API) so it works for
  // private repos. The user's git credential helper already authenticates
  // with the remote (proved by working push), so `git fetch` succeeds
  // without us having to manage tokens. Unauthenticated HTTP API calls
  // would return 404 for a private repo and the empty-catch swallow would
  // silently report "up to date" — the foot-gun this rewrite removes.
  if (method === "GET" && url.pathname === "/api/updates/check") {
    try {
      const { execSync } = await import("node:child_process");
      const repoRoot = process.cwd();
      const pkgPath = join(repoRoot, "package.json");
      const localPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const localVersion = localPkg.version || "0.0.0";
      let localCommit = "";
      try { localCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim(); }
      catch {
        // Not a git checkout (installed/tarball build) — fall back to the
        // rolling channel: compare the last-installed commit to remote main
        // HEAD. The very first check before any in-app update has no recorded
        // commit, so we optimistically report an update is available.
        try {
          const { OTAManager } = await import("../../ota-update.js");
          const ota = new OTAManager();
          const installed = await ota.readInstalledCommit();
          const { commit, subject } = await ota.checkMainCommit();
          const updateAvailable = installed ? installed !== commit : true;
          json(200, {
            localVersion,
            localCommit: installed ? installed.slice(0, 7) : "",
            remoteVersion: localVersion,
            remoteCommit: commit.slice(0, 7),
            updateAvailable,
            releaseNotes: subject,
            rolling: true,
          });
        } catch (e) {
          json(200, { localVersion, localCommit: "", remoteVersion: localVersion, remoteCommit: "", updateAvailable: false, releaseNotes: "", error: safeErrorMessage(e) });
        }
        return true;
      }
      const now = Date.now();
      // Cache window kept short (5 min) — these calls are cheap (one local
      // fetch) and a user clicking "Check for Updates" expects fresh data.
      // The original 60 min was sized for the rate-limited GitHub HTTP API.
      if (_updateCache && now - _updateCache.time < 300000) {
        json(200, { ..._updateCache.data, localVersion, localCommit, cached: true }); return true;
      }
      let remoteVersion = localVersion, remoteCommit = "", updateAvailable = false, releaseNotes = "", checkError: string | undefined;
      try {
        // 30s timeout: covers slow networks but won't hang the UI forever.
        execSync("git fetch origin main --quiet", { cwd: repoRoot, encoding: "utf-8", timeout: 30000 });
        remoteCommit = execSync("git rev-parse --short origin/main", { cwd: repoRoot, encoding: "utf-8" }).trim();
        try {
          const remotePkgRaw = execSync("git show origin/main:package.json", { cwd: repoRoot, encoding: "utf-8" });
          remoteVersion = (JSON.parse(remotePkgRaw) as { version?: string }).version || localVersion;
        } catch { /* package.json may be missing on remote — fall back to localVersion */ }
        try {
          releaseNotes = execSync("git log -1 --format=%s origin/main", { cwd: repoRoot, encoding: "utf-8" }).trim();
        } catch { /* non-fatal */ }
        updateAvailable = !!(remoteCommit && localCommit && remoteCommit !== localCommit) || remoteVersion !== localVersion;
      } catch (e) {
        // Surface the failure instead of pretending everything's fine.
        // Common cases: offline, git auth revoked, remote not reachable.
        const err = e as { stderr?: Buffer | string; message: string };
        const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() || "";
        checkError = (stderr || err.message).trim().split("\n")[0] || "git fetch failed";
      }
      const result: UpdateCheckResult = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes, ...(checkError ? { error: checkError } : {}) };
      // Only cache successful checks — don't lock in a transient error for 5 min.
      if (!checkError) _updateCache = { data: result, time: now };
      json(200, result);
    } catch (e) { json(200, { updateAvailable: false, error: safeErrorMessage(e) }); }
    return true;
  }

  // Apply update — git pull on the live repo, then let the caller trigger
  // a server restart (the desktop wrapper has IPC for that; browser users
  // restart manually). Server runs from src/ via tsx now (commit 260fd54),
  // so there's no compile step in this flow — pull + respawn is enough.
  if (method === "POST" && url.pathname === "/api/updates/apply") {
    try {
      const { execSync } = await import("node:child_process");
      // cwd is the repo root for both Electron-spawned and npm-run-dev paths
      // (per desktop/src/main.ts startServer which sets cwd: PROJECT_ROOT,
      // and standard npm script execution). Avoids brittle ../../../ math.
      const repoRoot = process.cwd();
      // Pre-flight: make sure this looks like the repo and that the working
      // tree is clean. Pulling onto uncommitted changes is the #1 way users
      // brick their install — refuse it loudly instead of failing mid-pull.
      let fromCommit = "";
      try { fromCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim(); }
      catch {
        // Not a git checkout — rolling/tarball install. Re-download main and
        // apply via OTAManager (backup → extract over the install dir →
        // record the new commit). The desktop relaunches to finish.
        try {
          const { OTAManager } = await import("../../ota-update.js");
          const ota = new OTAManager();
          const installed = (await ota.readInstalledCommit()) || "";
          const { commit } = await ota.checkMainCommit();
          if (installed && installed === commit) {
            json(200, { ok: true, fromCommit: installed.slice(0, 7), toCommit: commit.slice(0, 7), output: "Already up to date." });
            return true;
          }
          const tarPath = await ota.downloadMainTarball();
          await ota.applyUpdate(tarPath, repoRoot, installed || "rolling");
          await ota.writeInstalledCommit(commit);
          _updateCache = null;
          json(200, { ok: true, fromCommit: installed ? installed.slice(0, 7) : "", toCommit: commit.slice(0, 7), output: "Updated from main — relaunch to finish.", rolling: true });
        } catch (e) {
          json(500, { ok: false, error: safeErrorMessage(e) });
        }
        return true;
      }
      const dirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim();
      if (dirty) {
        json(409, { ok: false, error: "Local changes detected. Commit or stash before updating.", dirty: dirty.split("\n").slice(0, 10) });
        return true;
      }
      // Pull. Use --ff-only so we never auto-merge — if remote diverges
      // from local (impossible in normal usage, but guards against a
      // user with a custom branch), bail with a clear message.
      let pullOutput = "";
      try { pullOutput = execSync("git pull --ff-only", { cwd: repoRoot, encoding: "utf-8" }); }
      catch (e) {
        const err = e as { stderr?: Buffer | string; message: string };
        const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() || "";
        json(500, { ok: false, error: `git pull failed: ${stderr || err.message}` });
        return true;
      }
      const toCommit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
      _updateCache = null; // bust the check cache so next probe shows fresh state
      json(200, { ok: true, fromCommit, toCommit, output: pullOutput.trim() });
    } catch (e) { json(500, { ok: false, error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
