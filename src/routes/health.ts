/**
 * /api/health — process-level health probe for the supervisor.
 *
 * Returns memory, uptime, and a basic alive signal. Used by
 * scripts/supervisor.mjs to decide whether to force-recycle the child.
 *
 * Auth-exempt because the supervisor needs to probe before any user
 * authenticates. Returns no sensitive data — just process metrics — so the
 * exemption is safe even on a public network (though Local Agent X binds
 * to 127.0.0.1 anyway).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody } from "../server-utils.js";

const PROCESS_STARTED_AT = Date.now();
const APP_VERSION = (() => {
  try { return (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version?: string }).version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

// UI-freeze reports from the renderer's freeze probe (public/js/perf-longtask.js).
// The probe's ring buffer (window.__laxFreezeLog) dies with the window, which is
// why intermittent freezes went unattributed for weeks — this lands each event in
// server.log (console is mirrored there) next to server restart/OTA lines, so a
// freeze can be correlated with what the backend was doing at that moment.
// Bounded: at most 60 entries logged per process lifetime, then dropped silently.
let freezeReportsLogged = 0;
const FREEZE_REPORT_CAP = 60;

export const handleHealthRoutes: RouteHandler = async (method, url, req, res) => {
  if (method === "POST" && url.pathname === "/api/health/client-freeze") {
    const body = await safeParseBody(req).catch(() => null);
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    for (const e of entries.slice(0, 10)) {
      if (freezeReportsLogged >= FREEZE_REPORT_CAP) break;
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      const ms = Math.min(Math.round(Number(r.ms) || 0), 600_000);
      if (ms < 200) continue;
      const kind = r.kind === "longtask" ? "longtask" : "freeze";
      const where = typeof r.where === "string" ? r.where.slice(0, 120) : "";
      const at = typeof r.t === "string" ? r.t.slice(0, 32) : "";
      freezeReportsLogged++;
      console.warn(`[client-freeze] ${kind} ${ms}ms${where ? ` in:${where}` : ""}${at ? ` at:${at}` : ""}`);
    }
    jsonResponse(res, 200, { ok: true }, req);
    return true;
  }
  if (method !== "GET") return false;

  if (url.pathname === "/api/health") {
    const mem = process.memoryUsage();
    const limitMb = parseInt(process.env.LAX_HEAP_LIMIT_MB || "4096", 10);

    jsonResponse(res, 200, {
      ok: true,
      version: APP_VERSION,
      uptimeS: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
      heap: {
        usedMb: Math.round(mem.heapUsed / 1024 / 1024),
        totalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
        // Best-available limit. v8 doesn't always surface this cleanly; we read
        // LAX_HEAP_LIMIT_MB which the supervisor sets when spawning.
        limitMb,
      },
      pid: process.pid,
      nodeVersion: process.version,
    }, req);
    return true;
  }

  if (url.pathname === "/api/health/providers") {
    try {
      const { getProviderHealth } = await import("../ops/provider-matrix.js");
      jsonResponse(res, 200, { providers: getProviderHealth() }, req);
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message }, req);
    }
    return true;
  }

  if (url.pathname === "/api/health/workers") {
    try {
      const { schedulerSnapshot, listActiveCanonicalOps } = await import("../canonical-loop/index.js");
      const snap = schedulerSnapshot();
      const canonical = listActiveCanonicalOps();
      jsonResponse(res, 200, { queueDepth: snap.queueDepth, activeCount: snap.activeCount, canonical }, req);
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message }, req);
    }
    return true;
  }

  return false;
};
