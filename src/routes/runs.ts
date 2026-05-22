// Per-run activity trace + recent-runs index.
//
// GET /api/runs/recent?limit=N    — most recent persisted runs (any status).
// GET /api/runs/:id/trace          — full JSONL event stream for a run.
//
// Recent reuses AgentRunStore.list() — no parallel listing. Live in-flight
// runs surface through /api/agents/active; this index is finished-only.

import type { RouteHandler } from "../server-context.js";
import { jsonResponse } from "../server-utils.js";
import { readTrace } from "../agents/run-trace.js";

export const handleRunsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/runs/recent") {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 200);
    const { runs } = ctx.agentRunStore.list({ limit });
    json(200, {
      runs: runs.map((r) => ({
        id: r.id,
        role: r.role,
        name: r.name,
        task: r.task,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      })),
    });
    return true;
  }

  const traceMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/trace$/);
  if (method === "GET" && traceMatch) {
    const id = traceMatch[1];
    const events = readTrace(id);
    json(200, { runId: id, events });
    return true;
  }

  return false;
};
