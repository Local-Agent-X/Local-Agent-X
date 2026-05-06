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

import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";

const PROCESS_STARTED_AT = Date.now();

export const handleHealthRoutes: RouteHandler = async (method, url, req, res) => {
  if (method !== "GET") return false;

  if (url.pathname === "/api/health") {
    const mem = process.memoryUsage();
    const heapLimitBytes = (process as unknown as { resourceLimits?: () => { maxOldGenerationSizeMb?: number } }).resourceLimits?.()?.maxOldGenerationSizeMb;
    const limitMb = parseInt(process.env.LAX_HEAP_LIMIT_MB || "4096", 10);

    jsonResponse(res, 200, {
      ok: true,
      uptimeS: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
      heap: {
        usedMb: Math.round(mem.heapUsed / 1024 / 1024),
        totalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
        // Best-available limit. v8 doesn't always surface this cleanly; we read
        // LAX_HEAP_LIMIT_MB which the supervisor sets when spawning.
        limitMb: heapLimitBytes ?? limitMb,
      },
      pid: process.pid,
      nodeVersion: process.version,
    }, req);
    return true;
  }

  if (url.pathname === "/api/health/providers") {
    try {
      const { getProviderHealth } = await import("../workers/provider-matrix.js");
      jsonResponse(res, 200, { providers: getProviderHealth() }, req);
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message }, req);
    }
    return true;
  }

  if (url.pathname === "/api/health/workers") {
    try {
      const { getPoolStatus } = await import("../workers/pool.js");
      const { listActiveCanonicalOps } = await import("../canonical-loop/index.js");
      const pool = getPoolStatus();
      // Canonical-loop ops run in-process and are NOT registered in the
      // legacy worker-pool table. Surface them in the same payload so the
      // Agent activity sidebar / status views can render both paths.
      const canonical = listActiveCanonicalOps();
      jsonResponse(res, 200, { ...pool, canonical }, req);
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message }, req);
    }
    return true;
  }

  return false;
};
