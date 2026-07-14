import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";

export const handleAgentHistoryRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Agent run history — completed runs from AgentRunStore PLUS any
  // currently-in-flight FieldAgents from the Handler. Without the live
  // merge, the History tab is empty while a run is mid-flight (the
  // AgentRun record is only written on completion).
  if (method === "GET" && url.pathname === "/api/agents/history") {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const sessionId = url.searchParams.get("sessionId") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const historical = ctx.agentRunStore.list({ limit, offset, sessionId, status });
    let live: typeof historical.runs = [];
    if (!status || status === "working") {
      try {
        const handler = (await import("../../agency/handler.js")).Handler.getInstance();
        const active = handler.getAgentStatus();
        const liveList = Array.isArray(active) ? active : [active];
        // Shape FieldAgentStatus to the AgentRun-compatible record the
        // History UI expects. completedAt absent → frontend renders
        // "running Xs" instead of a finished duration.
        live = liveList.map((s) => ({
          id: s.id,
          parentAgentId: null,
          sessionId: "",
          name: s.name,
          role: s.role,
          task: s.currentTask ?? "",
          systemPrompt: "",
          status: "working" as const,
          output: [],
          result: "",
          toolsUsed: [],
          tokensUsed: s.tokensUsed ?? 0,
          startedAt: s.startedAt,
          completedAt: 0,
        }));
      } catch { /* no live agents available */ }
    }
    // Dedup by id — live wins so the UI sees the in-flight state if a
    // stale AgentRun got persisted while the Handler entry is still active.
    const seen = new Set(live.map((r) => r.id));
    const merged = [...live, ...historical.runs.filter((r) => !seen.has(r.id))];
    json(200, { runs: merged, total: historical.total + live.length });
    return true;
  }

  if (method === "GET" && url.pathname.match(/^\/api\/agents\/history\/[^/]+$/) && !url.pathname.includes("tree")) {
    const id = url.pathname.split("/").pop()!;
    const run = ctx.agentRunStore.get(id);
    if (!run) { json(404, { error: "Run not found" }); return true; }
    json(200, run); return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/agents\/history\/[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    json(ctx.agentRunStore.delete(id) ? 200 : 404, { ok: true }); return true;
  }

  if (method === "DELETE" && url.pathname === "/api/agents/history") {
    json(200, { ok: true, deleted: ctx.agentRunStore.clearAll() }); return true;
  }

  if (method === "GET" && url.pathname === "/api/agents/active") {
    try {
      const handler = (await import("../../agency/handler.js")).Handler.getInstance();
      json(200, handler.getAgentStatus());
    } catch { json(200, []); }
    return true;
  }

  // Agent redirect — HTTP fallback for when WS is unavailable. Routes by id
  // prefix; same split as the agent-control / agent-redirect WS handlers
  // in chat-ws.ts. op_* → canonical opRedirect, agent-* → Handler.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/[^/]+\/redirect$/)) {
    const agentId = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || typeof body.instruction !== "string") { json(400, { error: "instruction (string) required" }); return true; }
    try {
      if (agentId.startsWith("op_")) {
        const { opRedirect } = await import("../../canonical-loop/index.js");
        const res = opRedirect(agentId, body.instruction, "user");
        if (!res.ok) { json(404, { error: `op ${agentId} not running` }); return true; }
      } else {
        const handler = (await import("../../agency/handler.js")).Handler.getInstance();
        handler.redirectAgent(agentId, body.instruction);
      }
      json(200, { ok: true, agentId, instruction: body.instruction });
    } catch (e) { json(404, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "GET" && url.pathname.match(/^\/api\/agents\/tree\/[^/]+$/)) {
    const sessionId = url.pathname.split("/").pop()!;
    const runs = ctx.agentRunStore.getTree(sessionId);
    const rootRuns = runs.filter(r => !r.parentAgentId);
    const childMap = new Map<string, typeof runs>();
    for (const r of runs) {
      if (r.parentAgentId) {
        const arr = childMap.get(r.parentAgentId) || [];
        arr.push(r);
        childMap.set(r.parentAgentId, arr);
      }
    }
    interface AgentTreeNode extends Record<string, unknown> { id: string; children: AgentTreeNode[] }
    function buildNode(run: typeof runs[0]): AgentTreeNode {
      return { ...run, children: (childMap.get(run.id) || []).map(buildNode) };
    }
    json(200, rootRuns.map(buildNode)); return true;
  }

  return false;
};
