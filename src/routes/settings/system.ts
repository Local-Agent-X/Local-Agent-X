import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../../server-utils.js";
import { getToolStats, getToolSuccessRate, getRecentFailures } from "../../tool-tracker.js";
import { getProviderHealthStatus } from "../../model-fallback.js";
import { getThreatDashboard } from "../../threat-dashboard.js";

/** Typed cache for update check results stored on the module scope */
interface UpdateCheckResult { localVersion: string; localCommit: string; remoteVersion: string; remoteCommit: string; updateAvailable: boolean; releaseNotes: string }
let _updateCache: { data: UpdateCheckResult; time: number } | null = null;

/** GitHub commit response shape */
interface GitHubCommitResponse { sha?: string; commit?: { message?: string } }

/** GitHub package.json response shape */
interface GitHubPackageResponse { version?: string }

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
      browserMode: ctx.config.browserMode,
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

  // Update checker
  if (method === "GET" && url.pathname === "/api/updates/check") {
    try {
      const pkgPath = join(import.meta.dirname || ".", "..", "..", "package.json");
      const localPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const localVersion = localPkg.version || "0.0.0";
      let localCommit = "";
      try { const { execSync } = await import("node:child_process"); localCommit = execSync("git rev-parse --short HEAD", { cwd: join(import.meta.dirname || ".", "..", ".."), encoding: "utf-8" }).trim(); } catch {}
      const now = Date.now();
      if (_updateCache && now - _updateCache.time < 3600000) {
        json(200, { ..._updateCache.data, localVersion, localCommit, cached: true }); return true;
      }
      let remoteVersion = localVersion, remoteCommit = "", updateAvailable = false, releaseNotes = "";
      try {
        const commitRes = await fetch("https://api.github.com/repos/petermanrique101-sys/Local-Agent-X/commits/main", { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Local-Agent-X" } });
        if (commitRes.ok) { const d = await commitRes.json() as GitHubCommitResponse; remoteCommit = d.sha?.slice(0, 7) || ""; releaseNotes = d.commit?.message?.split("\n")[0] || ""; }
        const pkgRes = await fetch("https://raw.githubusercontent.com/petermanrique101-sys/Local-Agent-X/main/package.json", { headers: { "User-Agent": "Local-Agent-X" } });
        if (pkgRes.ok) { remoteVersion = (await pkgRes.json() as GitHubPackageResponse).version || localVersion; }
        updateAvailable = (remoteCommit && localCommit && remoteCommit !== localCommit) || remoteVersion !== localVersion;
      } catch {}
      const result: UpdateCheckResult = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes };
      _updateCache = { data: result, time: now };
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
      catch { json(400, { ok: false, error: "Not a git repository — auto-update needs a git checkout. Reinstall from GitHub to enable updates." }); return true; }
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
