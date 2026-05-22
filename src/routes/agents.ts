import type { RouteHandler } from "../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage, readBody } from "../server-utils.js";
import { getLaneStatus, setLaneConcurrency, type LaneName } from "../execution-lanes.js";
import { getProviderHealthStatus, resetProviderHealth, type ProviderId } from "../model-fallback.js";
import { linkIdentities, unlinkIdentity, getIdentityGroups, type ChannelType } from "../session-router.js";
import type { AgentTemplate, Project } from "../agent-store.js";
import { AgentTemplateSchema, LinkIdentitiesSchema, validateBody } from "../route-schemas.js";
import { PROVIDER_IDS, type ProviderId as CanonicalProviderId } from "../providers/provider-ids.js";
import { PROVIDERS } from "../providers/registry.js";
import type { AgentModelPin } from "../agents/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("routes.agents");

/** Create roster entries for any seeded agentIds on a freshly-created project.
 *  Mirrors what the legacy migration does for pre-L3 data: each entry becomes
 *  a real ProjectRoster row (the source of truth post-L3), with CEO-led trees
 *  auto-wiring reportsTo so the org chart isn't flat by default. */
async function seedProjectRosters(
  projectId: string,
  agentIds: string[],
  ctx: { projectStore: { addAgent(id: string, agentId: string): boolean } },
): Promise<void> {
  if (agentIds.length === 0) return;
  const { ProjectRosterStore } = await import("../project-rosters.js");
  const rosterStore = ProjectRosterStore.getInstance();
  const hasCeo = agentIds.includes("builtin-ceo");
  for (const agentId of agentIds) {
    rosterStore.upsert(projectId, agentId, {
      reportsTo: (hasCeo && agentId !== "builtin-ceo") ? "builtin-ceo" : undefined,
    });
    ctx.projectStore.addAgent(projectId, agentId);
  }
}

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

  // Agent templates CRUD — thin wrappers over AgentTemplateStore. The
  // canonical store is the source of truth; these routes exist purely
  // so the UI (public/js/agents.js) can reach it over HTTP. LLM agents
  // hit the same store through agent_create / agent_list tools.
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

  // Hire — always scoped to a project (canonical-agent-design Q4).
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+\/hire$/)) {
    const id = url.pathname.split("/")[4];
    const body = await safeParseBody(req);
    const projectId = body?.projectId as string | undefined;
    if (!projectId) { json(400, { error: "projectId is required — hire is always a Project action" }); return true; }
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

  // Fire — projectId required for the same reason hire takes one.
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

  // Patch a roster entry — reportsTo / heartbeatSchedule live per project
  // post-L3, so the old PUT /api/agents/templates/:id can't carry these.
  if (method === "PATCH" && url.pathname.match(/^\/api\/projects\/[^/]+\/rosters\/[^/]+$/)) {
    const parts = url.pathname.split("/");
    const projectId = parts[3];
    const agentId = parts[5];
    const body = await safeParseBody(req);
    if (!body) { json(400, { error: "Invalid JSON" }); return true; }

    // Model field — accepts {provider, model}, or null to clear the
    // per-project override (template default takes over again).
    // Validated against the canonical provider+model registry; bad
    // pairs reject 400 so the UI doesn't silently persist garbage.
    let modelField: AgentModelPin | null | undefined = undefined;
    if (body.model === null) {
      modelField = null;
    } else if (body.model && typeof body.model === "object") {
      const m = body.model as { provider?: unknown; model?: unknown };
      const provider = typeof m.provider === "string" ? m.provider : "";
      const modelName = typeof m.model === "string" ? m.model : "";
      if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
        json(400, { error: `Unknown provider "${provider}" — must be one of: ${PROVIDER_IDS.join(", ")}` });
        return true;
      }
      const reg = PROVIDERS[provider as CanonicalProviderId];
      if (reg.models.length > 0 && !reg.models.includes(modelName)) {
        json(400, { error: `Model "${modelName}" is not in the ${provider} registry. Known: ${reg.models.join(", ")}` });
        return true;
      }
      modelField = { provider: provider as CanonicalProviderId, model: modelName };
    }

    const { ProjectRosterStore } = await import("../project-rosters.js");
    const updated = ProjectRosterStore.getInstance().patch(projectId, agentId, {
      reportsTo: body.reportsTo as string | undefined,
      heartbeatSchedule: body.heartbeatSchedule as string | undefined,
      heartbeatEnabled: body.heartbeatEnabled as boolean | undefined,
      model: modelField,
    });
    if (!updated) { json(404, { error: "Roster entry not found" }); return true; }
    json(200, updated); return true;
  }

  // Rostered templates. With ?projectId=X, merges the project's roster
  // entries (per-project heartbeat / reportsTo) onto each template.
  // Without it, returns templates rostered in any project.
  if (method === "GET" && url.pathname === "/api/agents/hired") {
    const projectId = url.searchParams.get("projectId");
    if (projectId) {
      const { ProjectRosterStore } = await import("../project-rosters.js");
      const rosters = ProjectRosterStore.getInstance().listByProject(projectId);
      const merged = rosters.map((r) => {
        const tpl = ctx.agentTemplateStore.get(r.agentId);
        return tpl ? { ...tpl, reportsTo: r.reportsTo, heartbeatSchedule: r.heartbeatSchedule, heartbeatEnabled: r.heartbeatEnabled, budget: r.budget, projectId: r.projectId, model: r.model } : null;
      }).filter((x): x is NonNullable<typeof x> => x !== null);
      json(200, merged); return true;
    }
    json(200, ctx.agentTemplateStore.listHired()); return true;
  }

  // Spawn from template — routes through the canonical invokeDefinition
  // surface so the run is persisted to ~/.lax/operations/<opId>/events.jsonl
  // and shares the FieldAgent registry with every other spawn door.
  if (method === "POST" && url.pathname.match(/^\/api\/agents\/templates\/[^/]+\/spawn$/)) {
    const id = url.pathname.split("/")[4];
    const tpl = ctx.agentTemplateStore.get(id);
    if (!tpl) { json(404, { error: "Template not found" }); return true; }
    const body = await safeParseBody(req);
    const task = (body?.task as string) || "Execute your role";
    try {
      const { invokeDefinition } = await import("../agents/invoke.js");
      const ref = invokeDefinition(
        {
          id: tpl.id,
          name: tpl.name,
          role: tpl.role,
          systemPrompt: tpl.systemPrompt,
          allowedTools: tpl.allowedTools,
          description: tpl.description ?? "",
          icon: tpl.icon,
          requiresWorktree: tpl.requiresWorktree,
        },
        task,
      );
      json(200, { ok: true, agentId: ref.runId });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
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
    await seedProjectRosters(project.id, (body.agentIds as string[]) || [], ctx);
    json(200, project); return true;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    json(200, ctx.projectStore.list()); return true;
  }
  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await safeParseBody(req);
    if (!body || !body.name) { json(400, { error: "name required" }); return true; }
    const project = ctx.projectStore.create({ name: body.name as string, description: (body.description as string) || "", workspace: body.workspace as string | undefined, agentIds: (body.agentIds as string[]) || [], secretKeys: body.secretKeys as string[] | undefined, allowedTools: body.allowedTools as string[] | undefined });
    // Mirror from-starter — any seeded agentIds become real roster entries
    // (the L3 source of truth). Without this, a project created with
    // agentIds:[...] looked populated on disk but had zero hires for the
    // Team tab / org chart / membership reads.
    await seedProjectRosters(project.id, (body.agentIds as string[]) || [], ctx);
    json(200, project); return true;
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
