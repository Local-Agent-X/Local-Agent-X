import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage, readBody } from "../server-utils.js";
import { getLaneStatus, setLaneConcurrency, type LaneName } from "../execution-lanes.js";
import { getProviderHealthStatus, resetProviderHealth, type ProviderId } from "../model-fallback.js";
import { resolveSession, linkIdentities, unlinkIdentity, getIdentityGroups, type ChannelType } from "../session-router.js";
import type { IssueStatus, AgentTemplate, Issue, Project } from "../agent-store.js";
import { AgentTemplateSchema, CreateIssueSchema, IssueCommentSchema, CreateProjectSchema, LinkIdentitiesSchema, validateBody } from "../route-schemas.js";

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
  // in chat-ws.ts. Without the prefix split, op_* worker-pool ops silently
  // no-op'd because Handler doesn't track them.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/[^/]+\/redirect$/)) {
    const agentId = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || typeof body.instruction !== "string") { json(400, { error: "instruction (string) required" }); return true; }
    try {
      if (agentId.startsWith("op_")) {
        const { redirectOp } = await import("../workers/pool.js");
        const ok = redirectOp(agentId, body.instruction);
        if (!ok) { json(404, { error: `op ${agentId} not running` }); return true; }
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

  // Agent templates CRUD
  if (method === "GET" && url.pathname === "/api/agents/templates") {
    json(200, ctx.agentTemplateStore.list()); return true;
  }

  if (method === "POST" && url.pathname === "/api/agents/templates") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, AgentTemplateSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    json(200, ctx.agentTemplateStore.create(parsed.data as Omit<AgentTemplate, "id" | "createdAt" | "updatedAt">)); return true;
  }

  if (method === "PUT" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const updated = ctx.agentTemplateStore.update(id, body as Partial<AgentTemplate>);
    if (!updated) { json(404, { error: "Template not found" }); return true; }
    json(200, updated); return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+$/)) {
    const id = url.pathname.split("/").pop()!;
    json(ctx.agentTemplateStore.delete(id) ? 200 : 404, { ok: true }); return true;
  }

  // Hire agent — always into a project. projectId required.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+\/hire$/)) {
    const id = url.pathname.split("/")[4];
    const body = await safeParseBody(req);
    const projectId = body?.projectId as string | undefined;
    if (!projectId) { json(400, { error: "projectId is required — hire is always a Project action (canonical-agent-design Q4)" }); return true; }
    const tpl = ctx.agentTemplateStore.get(id);
    if (!tpl) { json(404, { error: "Template not found" }); return true; }
    const project = ctx.projectStore.get(projectId);
    if (!project) { json(404, { error: "Project not found" }); return true; }

    const { ProjectRosterStore } = await import("../project-rosters.js");
    const rosterStore = ProjectRosterStore.getInstance();
    const entry = rosterStore.upsert(projectId, id, {
      reportsTo: body?.reportsTo as string | undefined,
      heartbeatSchedule: body?.heartbeatSchedule as string | undefined,
    });
    ctx.projectStore.addAgent(projectId, id);

    // Project-scoped heartbeat cron — same agent can have different
    // schedules in different projects, so the cron id encodes both.
    if (entry.heartbeatSchedule && entry.heartbeatEnabled) {
      const projectRoster = rosterStore.listByProject(projectId);
      const isManager = tpl.role === "ceo" || projectRoster.some((r) => r.reportsTo === id);
      const managerProcedure = `THEN follow this MANAGER procedure:\n1. Call agent_team_list to see your team\n2. Call issue_list to see ALL open issues\n3. Review completed tasks: leave feedback\n4. Review blocked tasks: help unblock\n5. Assign unassigned work\n6. Create brief status update\n7. If report hasn't made progress, use agent_wakeup\n`;
      const workerProcedure = `THEN follow this procedure:\n1. Review assigned issues — pick highest priority\n2. Call issue_checkout to lock it\n3. Read new comments\n4. Do the work\n5. Call issue_update to report\n6. If done, set status to "done"\n7. If blocked, set to "blocked" with comment\n8. Call issue_release when finished\n`;
      const heartbeatPrompt = `You are ${tpl.name} (${tpl.role}), agent ID: ${id}. You are waking up for your scheduled check-in in project ${project.name}.\n\nFIRST: Call agent_whoami with agentId="${id}".\n\n` + (isManager ? managerProcedure : workerProcedure) + `\nYour instructions: ${tpl.systemPrompt}`;
      try {
        ctx.cronService.create(`heartbeat:${projectId}:${id}`, entry.heartbeatSchedule, heartbeatPrompt, true);
        logger.info(`[heartbeat] Created heartbeat for ${tpl.name} in ${project.name}: ${entry.heartbeatSchedule}`);
      } catch (e) { logger.warn(`[heartbeat] Failed to create: ${(e as Error).message}`); }
    }
    json(200, { template: tpl, roster: entry }); return true;
  }

  // Fire agent — projectId required for the same reason hire takes one.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+\/fire$/)) {
    const id = url.pathname.split("/")[4];
    const body = await safeParseBody(req);
    const projectId = body?.projectId as string | undefined;
    if (!projectId) { json(400, { error: "projectId is required — fire is always a Project action" }); return true; }
    const { ProjectRosterStore } = await import("../project-rosters.js");
    try { ctx.cronService.delete(`heartbeat:${projectId}:${id}`); } catch { /* might not exist */ }
    const removed = ProjectRosterStore.getInstance().remove(projectId, id);
    ctx.projectStore.removeAgent(projectId, id);
    json(removed ? 200 : 404, { ok: removed }); return true;
  }

  // Patch a roster entry — reportsTo / heartbeatSchedule live here now,
  // per project. The old PUT /api/agents/templates/:id can't carry
  // these anymore because they're not on the template.
  if (method === "PATCH" && url.pathname.match(/^\/api\/projects\/[^/]+\/rosters\/[^/]+$/)) {
    const parts = url.pathname.split("/");
    const projectId = parts[3];
    const agentId = parts[5];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const { ProjectRosterStore } = await import("../project-rosters.js");
    const updated = ProjectRosterStore.getInstance().patch(projectId, agentId, {
      reportsTo: body.reportsTo as string | undefined,
      heartbeatSchedule: body.heartbeatSchedule as string | undefined,
      heartbeatEnabled: body.heartbeatEnabled as boolean | undefined,
    });
    if (!updated) { json(404, { error: "Roster entry not found" }); return true; }
    json(200, updated); return true;
  }

  // Backward-compat: returns templates that are rostered somewhere.
  // When ?projectId=X is provided, response is the project's roster
  // entries merged with their template (per-project heartbeat / reportsTo
  // visible). Without it, returns templates only (definition-level data).
  if (method === "GET" && url.pathname === "/api/agents/hired") {
    const projectId = url.searchParams.get("projectId");
    if (projectId) {
      const { ProjectRosterStore } = await import("../project-rosters.js");
      const rosters = ProjectRosterStore.getInstance().listByProject(projectId);
      const merged = rosters.map((r) => {
        const tpl = ctx.agentTemplateStore.get(r.agentId);
        return tpl ? { ...tpl, reportsTo: r.reportsTo, heartbeatSchedule: r.heartbeatSchedule, heartbeatEnabled: r.heartbeatEnabled, budget: r.budget, projectId: r.projectId } : null;
      }).filter((x): x is NonNullable<typeof x> => x !== null);
      json(200, merged); return true;
    }
    json(200, ctx.agentTemplateStore.listHired()); return true;
  }

  // Spawn from template
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+\/spawn$/)) {
    const id = url.pathname.split("/")[4];
    const tpl = ctx.agentTemplateStore.get(id);
    if (!tpl) { json(404, { error: "Template not found" }); return true; }
    const body = await safeParseBody(req);
    const task = (body?.task as string) || "Execute your role";
    try {
      const handler = (await import("../agency/handler.js")).Handler.getInstance();
      json(200, { ok: true, agentId: handler.spawnAgent({
        name: tpl.name, role: tpl.role, task,
        systemPrompt: tpl.systemPrompt,
        tools: tpl.allowedTools.length > 0 ? tpl.allowedTools : undefined,
        templateId: tpl.id,
      }) });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  // ── Issues / Tasks ──

  if (method === "GET" && url.pathname === "/api/issues") {
    const assignee = url.searchParams.get("assignee") || undefined;
    const status = (url.searchParams.get("status") || undefined) as IssueStatus | undefined;
    const project = url.searchParams.get("project") || undefined;
    json(200, ctx.issueStore.list({ assignee, status, project })); return true;
  }

  if (method === "POST" && url.pathname === "/api/issues") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, CreateIssueSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    const issue = ctx.issueStore.create(parsed.data as Omit<Issue, "id" | "comments" | "createdAt" | "updatedAt">);
    ctx.broadcastAll({ type: "issue:created", issue });
    json(200, issue); return true;
  }

  if (method === "GET" && url.pathname.match(/^\/api\/issues\/(SAX|LAX)-\d+$/)) {
    const id = url.pathname.split("/").pop()!;
    const issue = ctx.issueStore.get(id);
    if (!issue) { json(404, { error: "Issue not found" }); return true; }
    json(200, issue); return true;
  }

  if (method === "PUT" && url.pathname.match(/^\/api\/issues\/(SAX|LAX)-\d+$/)) {
    const id = url.pathname.split("/").pop()!;
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }
    const updated = ctx.issueStore.update(id, body as Partial<Issue>);
    if (!updated) { json(404, { error: "Issue not found" }); return true; }
    ctx.broadcastAll({ type: "issue:updated", issue: updated });
    json(200, updated); return true;
  }

  if (method === "DELETE" && url.pathname.match(/^\/api\/issues\/(SAX|LAX)-\d+$/)) {
    const id = url.pathname.split("/").pop()!;
    json(ctx.issueStore.delete(id) ? 200 : 404, { ok: true }); return true;
  }

  // Issue comments
  if (method === "POST" && url.pathname.match(/^\/api\/issues\/(SAX|LAX)-\d+\/comments$/)) {
    const id = url.pathname.split("/")[3];
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, IssueCommentSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    const comment = ctx.issueStore.comment(id, parsed.data.author as string, parsed.data.content);
    if (!comment) { json(404, { error: "Issue not found" }); return true; }
    json(200, comment); return true;
  }

  if (method === "GET" && url.pathname === "/api/issues/stats") {
    json(200, ctx.issueStore.stats()); return true;
  }

  // Dashboard stats
  if (method === "GET" && url.pathname === "/api/dashboard/stats") {
    const issueStats = ctx.issueStore.stats();
    const hired = ctx.agentTemplateStore.listHired();
    const projects = ctx.projectStore.list();
    const laneInfo = getLaneStatus();
    json(200, {
      agents: { hired: hired.length, active: laneInfo.agent?.active || 0 },
      issues: issueStats, projects: projects.length, lanes: laneInfo,
    }); return true;
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
  if (method === "GET" && url.pathname === "/api/projects/starters") {
    json(200, [
      { name: "Content Creator", description: "Social media content pipeline", agents: ["builtin-researcher", "builtin-writer", "builtin-browser"], icon: "🎨" },
      { name: "Small Business", description: "Business operations", agents: ["builtin-researcher", "builtin-writer", "builtin-analyst"], icon: "🏢" },
      { name: "Student Researcher", description: "Academic research", agents: ["builtin-researcher", "builtin-deep-researcher", "builtin-writer"], icon: "📚" },
      { name: "Dev Team", description: "Software development", agents: ["builtin-coder", "builtin-reviewer", "builtin-researcher"], icon: "💻" },
      { name: "Marketing Agency", description: "Marketing ops", agents: ["builtin-researcher", "builtin-writer", "builtin-analyst", "builtin-browser"], icon: "📣" },
    ]); return true;
  }

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
    json(ctx.projectStore.delete(id) ? 200 : 404, { ok: true }); return true;
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
