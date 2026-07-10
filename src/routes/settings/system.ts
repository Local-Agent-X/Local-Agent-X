import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody, safeErrorMessage } from "../../server-utils.js";
import { getToolStats, getToolSuccessRate, getRecentFailures } from "../../tool-tracker.js";
import { getProviderHealthStatus } from "../../model-fallback.js";
import { getThreatDashboard } from "../../threat/threat-dashboard.js";

export const handleSystemRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // /api/health lives in routes/health.ts (first in the dispatch chain) —
  // it owns the route and reports the app version.

  // System status
  if (method === "GET" && url.pathname === "/api/system-status") {
    const { getSandboxStatus, isDockerAvailable, isGuardedUsable } = await import("../../sandbox/index.js");
    const { loadProfileName } = await import("../../autonomy/profile-store.js");
    const threatData = getThreatDashboard();
    const providerHealth = getProviderHealthStatus();
    const tStats = getToolStats();
    const sandboxStatus = getSandboxStatus();
    json(200, {
      profile: ctx.config.profile, toolApproval: ctx.config.toolApproval,
      autonomyProfile: loadProfileName(),
      retentionDays: ctx.config.retentionDays, autoUpdate: ctx.config.autoUpdate, logLevel: ctx.config.logLevel,
      sandbox: { mode: sandboxStatus.effectiveMode, ...sandboxStatus, dockerAvailable: isDockerAvailable(), guardedAvailable: isGuardedUsable() },
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
    const { getSandboxStatus, isDockerAvailable, isGuardedUsable } = await import("../../sandbox/index.js");
    const status = getSandboxStatus();
    json(200, { mode: status.effectiveMode, ...status, dockerAvailable: isDockerAvailable(), guardedAvailable: isGuardedUsable(), dockerDownloadUrl: "https://www.docker.com/products/docker-desktop/" }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sandbox") {
    const body = await readBody(req);
    const { mode, acknowledgeUnconfinedHost, revokeUnconfinedHostAcknowledgement } = JSON.parse(body);
    if (revokeUnconfinedHostAcknowledgement === true) {
      const { getSandboxStatus, setUnconfinedHostAcknowledgement } = await import("../../sandbox/index.js");
      setUnconfinedHostAcknowledgement(false);
      const status = getSandboxStatus();
      ctx.broadcastAll({ type: "settings_changed", settings: { sandbox: status } });
      json(200, { ok: true, mode: status.effectiveMode, ...status }); return true;
    }
    if (acknowledgeUnconfinedHost === true) {
      const { getSandboxStatus, setUnconfinedHostAcknowledgement } = await import("../../sandbox/index.js");
      const current = getSandboxStatus();
      if (current.confined) { json(409, { error: "The effective sandbox is confined; there is no unconfined host state to acknowledge.", ...current }); return true; }
      setUnconfinedHostAcknowledgement(true);
      const status = getSandboxStatus();
      ctx.broadcastAll({ type: "settings_changed", settings: { sandbox: status } });
      json(200, { ok: true, mode: status.effectiveMode, ...status }); return true;
    }
    if (mode !== "host" && mode !== "guarded" && mode !== "docker") { json(400, { error: "Invalid mode" }); return true; }
    const { setSandboxMode, getSandboxStatus } = await import("../../sandbox/index.js");
    const result = setSandboxMode(mode);
    const status = getSandboxStatus();
    if (result.ok) ctx.broadcastAll({ type: "settings_changed", settings: { sandbox: status } });
    json(result.ok ? 200 : 400, { ...result, mode: status.effectiveMode, ...status }); return true;
  }

  // Update check + apply — the implementation lives in update-service.ts so the
  // agent tools (check_for_updates / apply_update) share it. Apply routes
  // through update-pipeline's validated swap (deps/build/bind/smoke gates);
  // nothing overwrites the live install until the candidate passes. The caller
  // restarts to finish (desktop has IPC for that; browser users restart manually).
  if (method === "GET" && url.pathname === "/api/updates/check") {
    const { checkForUpdate } = await import("../../update-service.js");
    json(200, await checkForUpdate());
    return true;
  }

  if (method === "POST" && url.pathname === "/api/updates/apply") {
    try {
      const { applyUpdateNow } = await import("../../update-service.js");
      const result = await applyUpdateNow();
      if (result.ok) {
        json(200, { ok: true, fromCommit: result.fromCommit, toCommit: result.toCommit, output: result.detail, ...(result.rolling ? { rolling: true } : {}) });
      } else {
        json(result.held ? 409 : 500, { ok: false, held: !!result.held, fromCommit: result.fromCommit, toCommit: result.toCommit, error: result.detail, ...(result.rolling ? { rolling: true } : {}) });
      }
    } catch (e) { json(500, { ok: false, error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
