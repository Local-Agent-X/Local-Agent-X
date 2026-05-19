import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage, readBody } from "../server-utils.js";
import { getLaneStatus, setLaneConcurrency, type LaneName } from "../execution-lanes.js";
import { getProviderHealthStatus, resetProviderHealth, type ProviderId } from "../model-fallback.js";
import { linkIdentities, unlinkIdentity, getIdentityGroups, type ChannelType } from "../session-router.js";
import type { Project } from "../agent-store.js";
import { LinkIdentitiesSchema, validateBody } from "../route-schemas.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.agents");

export const handleAgentRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
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
        const handler = (await import("../agency/handler.js")).Handler.getInstance();
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
    // Dedup by id (a run could theoretically appear in both if a stale
    // AgentRun got written while the Handler entry is still active —
    // not expected today, but the dedup keeps it safe). Live wins so
    // the UI sees the current in-flight state.
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

  // Active agents
  if (method === "GET" && url.pathname === "/api/agents/active") {
    try {
      const handler = (await import("../agency/handler.js")).Handler.getInstance();
      json(200, handler.getAgentStatus());
    } catch { json(200, []); }
    return true;
  }

  // Agent redirect (HTTP fallback for when WS is unavailable). Routes by id
  // prefix — same split as the agent-control / agent-redirect WS handlers
  // in chat-ws.ts. op_* → canonical opRedirect, agent-* → Handler.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/[^/]+\/redirect$/)) {
    const agentId = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || typeof body.instruction !== "string") { json(400, { error: "instruction (string) required" }); return true; }
    try {
      if (agentId.startsWith("op_")) {
        const { opRedirect } = await import("../canonical-loop/index.js");
        const res = opRedirect(agentId, body.instruction, "user");
        if (!res.ok) { json(404, { error: `op ${agentId} not running` }); return true; }
      } else {
        const handler = (await import("../agency/handler.js")).Handler.getInstance();
        handler.redirectAgent(agentId, body.instruction);
      }
      json(200, { ok: true, agentId, instruction: body.instruction });
    } catch (e) { json(404, { error: safeErrorMessage(e) }); }
    return true;
  }

  // Agent hierarchy tree
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

  // Lanes
  if (method === "GET" && url.pathname === "/api/lanes") {
    json(200, getLaneStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/lanes/concurrency") {
    const body = await safeParseBody(req);
    if (!body || !body.lane || !body.maxConcurrent) { json(400, { error: "lane and maxConcurrent required" }); return true; }
    setLaneConcurrency(body.lane as LaneName, parseInt(String(body.maxConcurrent), 10));
    json(200, { ok: true }); return true;
  }

  // Identity links
  if (method === "GET" && url.pathname === "/api/identity-links") {
    json(200, getIdentityGroups()); return true;
  }
  if (method === "POST" && url.pathname === "/api/identity-links") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, LinkIdentitiesSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    json(200, linkIdentities(parsed.data.identity1, parsed.data.identity2, parsed.data.displayName)); return true;
  }
  if (method === "DELETE" && url.pathname === "/api/identity-links") {
    const body = await safeParseBody(req);
    if (!body || !body.channel || !body.id) { json(400, { error: "channel and id required" }); return true; }
    json(unlinkIdentity(body.channel as ChannelType, body.id as string) ? 200 : 404, { ok: true }); return true;
  }

  // Provider health
  if (method === "GET" && url.pathname === "/api/providers/health") {
    json(200, getProviderHealthStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/providers/health/reset") {
    const body = await safeParseBody(req);
    if (!body || !body.provider) { json(400, { error: "provider required" }); return true; }
    resetProviderHealth(body.provider as ProviderId);
    json(200, { ok: true }); return true;
  }

  // Projects
  if (method === "POST" && url.pathname === "/api/projects/from-starter") {
    const body = await safeParseBody(req);
    if (!body || !body.name) { json(400, { error: "name required" }); return true; }
    const project = ctx.projectStore.create({ name: body.name as string, description: (body.description as string) || "", agentIds: (body.agentIds as string[]) || [], workspace: body.workspace as string | undefined });
    const agentIds: string[] = (body.agentIds as string[]) || [];
    const hasCeo = agentIds.includes("builtin-ceo");
    const { ProjectRosterStore } = await import("../project-rosters.js");
    const rosterStore = ProjectRosterStore.getInstance();
    for (const agentId of agentIds) {
      rosterStore.upsert(project.id, agentId, {
        reportsTo: (hasCeo && agentId !== "builtin-ceo") ? "builtin-ceo" : undefined,
      });
      ctx.projectStore.addAgent(project.id, agentId);
    }
    json(200, project); return true;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    json(200, ctx.projectStore.list()); return true;
  }
  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await safeParseBody(req);
    if (!body || !body.name) { json(400, { error: "name required" }); return true; }
    json(200, ctx.projectStore.create({ name: body.name as string, description: (body.description as string) || "", workspace: body.workspace as string | undefined, agentIds: (body.agentIds as string[]) || [], secretKeys: body.secretKeys as string[] | undefined, allowedTools: body.allowedTools as string[] | undefined })); return true;
  }
  if (method === "GET" && url.pathname.match(/^\/api\/projects\/proj-[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    const project = ctx.projectStore.get(id);
    if (!project) { json(404, { error: "Project not found" }); return true; }
    json(200, project); return true;
  }
  if (method === "PUT" && url.pathname.match(/^\/api\/projects\/proj-[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const updated = ctx.projectStore.update(id, body as Partial<Project>);
    if (!updated) { json(404, { error: "Project not found" }); return true; }
    json(200, updated); return true;
  }
  if (method === "DELETE" && url.pathname.match(/^\/api\/projects\/proj-[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    // Write a tombstone BEFORE the local delete so the intent survives
    // a sync pull from a machine that still has this project. Without
    // the tombstone, a remote agent-projects.json overwrites local
    // and the project comes back on next pull.
    try {
      const proj = ctx.projectStore.get(id);
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const { projectTombstonePaths, tombstoneProject } = await import("../sync/project-tombstones.js");
      const dataDir = join(homedir(), ".lax");
      const syncDir = join(dataDir, "sync-repo");
      tombstoneProject(projectTombstonePaths(dataDir, syncDir), id, proj?.name);
    } catch (e) {
      logger.warn(`[sync] project tombstone write failed for ${id}: ${(e as Error).message}`);
    }
    const deleted = ctx.projectStore.delete(id);
    if (deleted) { try { ctx.agentSync.notifyChange(`project-delete:${id}`); } catch {} }
    json(deleted ? 200 : 404, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/projects\/proj-[^/]+\/agents$/)) {
    const id = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || !body.agentId) { json(400, { error: "agentId required" }); return true; }
    json(ctx.projectStore.addAgent(id, body.agentId as string) ? 200 : 404, { ok: true }); return true;
  }
  if (method === "DELETE" && url.pathname.match(/^\/api\/projects\/proj-[^/]+\/agents$/)) {
    const id = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || !body.agentId) { json(400, { error: "agentId required" }); return true; }
    json(ctx.projectStore.removeAgent(id, body.agentId as string) ? 200 : 404, { ok: true }); return true;
  }

  // Active chats
  if (method === "GET" && url.pathname === "/api/chats/active") {
    json(200, { active: ctx.chatWs.getActiveChats() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/chats/stop") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const sid = String(body.sessionId || "");
    if (!sid) { json(400, { error: "sessionId required" }); return true; }
    const stopped = ctx.chatWs.stopChat(sid);
    // Abort + release the turn lock — mirrors the WS stop handler in chat-ws.ts.
    // Without releaseTurn the next message hits "previous request still running"
    // because the lock waits for the agent loop's finally block, which can take
    // 60s+ if a subprocess stalls. Stop should mean stop.
    let lockAborted = false;
    try {
      const { abortTurn, releaseTurn } = await import("../session-turn-lock.js");
      lockAborted = abortTurn(sid);
      releaseTurn(sid);
    } catch {}
    json(200, { ok: true, stopped: sid, wasActive: stopped, turnLockAborted: lockAborted }); return true;
  }
  // Active-turn status probe. Frontend hits this to show "agent is working —
  // iteration 5, last tool: bash, 42s elapsed" instead of a bare spinner.
  if (method === "GET" && url.pathname.match(/^\/api\/chats\/[^/]+\/status$/)) {
    const sid = decodeURIComponent(url.pathname.split("/")[3]);
    try {
      const { getActiveTurn } = await import("../session-turn-lock.js");
      const turn = getActiveTurn(sid);
      json(200, { active: turn !== null, turn });
    } catch { json(200, { active: false, turn: null }); }
    return true;
  }

  return false;
};
