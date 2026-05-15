/**
 * Autopilot HTTP routes.
 *
 *   POST   /api/autopilot/start          → start a new autopilot session
 *   POST   /api/autopilot/stop/:opId     → request stop (current round finishes)
 *   GET    /api/autopilot/status         → list active autopilot ops
 *   GET    /api/autopilot/status/:opId   → fetch a specific op's state
 *   GET    /api/autopilot/lock           → inspect the per-repo lock holder
 */

import { join } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../server-utils.js";
import { startAutopilot } from "../autopilot/start.js";
import { requestStop, getActiveAutopilotOp, listActiveAutopilotOps } from "../autopilot/loop.js";
import type { ProviderId } from "../providers/provider-ids.js";
import { readLock } from "../autopilot/lock.js";
import { resolveProvider } from "../agent-request.js";
import type { StartAutopilotRequest } from "../autopilot/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.autopilot");

export const handleAutopilotRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // POST /api/autopilot/start
  if (method === "POST" && url.pathname === "/api/autopilot/start") {
    const body = await safeParseBody(req);
    if (!body || typeof body.topic !== "string" || !Array.isArray(body.scope)) {
      json(400, { error: "topic (string) and scope (string[]) required" });
      return true;
    }
    try {
      const { provider, apiKey, model } = await resolveProvider(ctx.config, ctx.secretsStore, ctx.dataDir);
      if (!apiKey) {
        json(400, { error: "No provider API key available — check your auth setup" });
        return true;
      }
      const workspaceDir = join(ctx.dataDir, "operations");
      const result = await startAutopilot(body as unknown as StartAutopilotRequest, {
        config: ctx.config,
        apiKey,
        model,
        provider: provider as ProviderId,
        allTools: ctx.allAgentTools,
        workspaceDir,
      });
      if (!result.ok) {
        json(result.conflict ? 409 : 400, result);
        return true;
      }
      json(200, result);
    } catch (e) {
      logger.error(`[autopilot.start] ${safeErrorMessage(e)}`);
      json(500, { error: safeErrorMessage(e) });
    }
    return true;
  }

  // POST /api/autopilot/stop/:opId
  if (method === "POST" && url.pathname.match(/^\/api\/autopilot\/stop\/[^/]+$/)) {
    const opId = url.pathname.split("/").pop()!;
    const op = getActiveAutopilotOp(opId);
    if (!op) {
      json(404, { error: `Autopilot op ${opId} not found or not running` });
      return true;
    }
    const newlyRequested = requestStop(opId);
    json(200, {
      ok: true,
      opId,
      stopRequested: true,
      alreadyRequested: !newlyRequested,
      note: "Current round will finish, then the loop will exit.",
    });
    return true;
  }

  // GET /api/autopilot/status (list all active)
  if (method === "GET" && url.pathname === "/api/autopilot/status") {
    const ops = listActiveAutopilotOps().map(op => ({
      id: op.id,
      topic: op.autopilot?.topic,
      branch: op.autopilot?.branchName,
      startedAt: op.startedAt,
      rounds: (op.autopilotRounds || []).length,
      status: op.status,
    }));
    json(200, { active: ops });
    return true;
  }

  // GET /api/autopilot/status/:opId
  if (method === "GET" && url.pathname.match(/^\/api\/autopilot\/status\/[^/]+$/)) {
    const opId = url.pathname.split("/").pop()!;
    const op = getActiveAutopilotOp(opId);
    if (op) {
      json(200, {
        active: true,
        id: op.id,
        autopilot: op.autopilot,
        status: op.status,
        startedAt: op.startedAt,
        rounds: op.autopilotRounds || [],
        events: op.events.slice(-30),
      });
      return true;
    }
    // Not active — try the persisted operation.json + summary.md
    try {
      const opDir = join(ctx.dataDir, "operations", opId);
      const { existsSync, readFileSync } = await import("node:fs");
      const opJson = join(opDir, "operation.json");
      if (!existsSync(opJson)) {
        json(404, { error: `op ${opId} not found` });
        return true;
      }
      const persisted = JSON.parse(readFileSync(opJson, "utf-8"));
      const summaryPath = join(opDir, "summary.md");
      const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : null;
      json(200, { active: false, id: opId, persisted, summary });
    } catch (e) {
      json(500, { error: safeErrorMessage(e) });
    }
    return true;
  }

  // GET /api/autopilot/lock
  if (method === "GET" && url.pathname === "/api/autopilot/lock") {
    json(200, { holder: readLock() });
    return true;
  }

  return false;
};
