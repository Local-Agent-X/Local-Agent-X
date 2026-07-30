import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import type { AgentTemplate } from "../../agent-store/index.js";
import { AgentTemplateSchema, validateBody } from "../../route-schemas.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.agents.templates");

export const handleAgentTemplateRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Agent templates CRUD — thin wrappers over AgentTemplateStore. The
  // canonical store is the source of truth; these routes exist purely so
  // the UI (public/js/agents.js) can reach it over HTTP. LLM agents hit
  // the same store through agent_create / agent_list tools.
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

    const { ProjectRosterStore } = await import("../../project-rosters.js");
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
    const { ProjectRosterStore } = await import("../../project-rosters.js");
    try { ctx.cronService.delete(`heartbeat:${projectId}:${id}`); } catch { /* might not exist */ }
    const removed = ProjectRosterStore.getInstance().remove(projectId, id);
    ctx.projectStore.removeAgent(projectId, id);
    json(removed ? 200 : 404, { ok: removed }); return true;
  }

  // Rostered templates. With ?projectId=X, merges the project's roster
  // entries (per-project heartbeat / reportsTo) onto each template.
  // Without it, returns templates rostered in any project.
  if (method === "GET" && url.pathname === "/api/agents/hired") {
    const projectId = url.searchParams.get("projectId");
    if (projectId) {
      const { ProjectRosterStore } = await import("../../project-rosters.js");
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
      const { invokeDefinition } = await import("../../agents/invoke.js");
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

  return false;
};
