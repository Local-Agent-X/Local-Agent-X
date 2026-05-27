import type { RouteHandler, ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import type { Project } from "../../agent-store.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.agents.projects");

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
  const { ProjectRosterStore } = await import("../../project-rosters.js");
  const rosterStore = ProjectRosterStore.getInstance();
  const hasCeo = agentIds.includes("builtin-ceo");
  for (const agentId of agentIds) {
    rosterStore.upsert(projectId, agentId, {
      reportsTo: (hasCeo && agentId !== "builtin-ceo") ? "builtin-ceo" : undefined,
    });
    ctx.projectStore.addAgent(projectId, agentId);
  }
}

export const handleProjectRoutes: RouteHandler = async (method, url, req, res, ctx: ServerContext, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

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
      const { join } = await import("node:path");
      const { getLaxDir } = await import("../../lax-data-dir.js");
      const { projectTombstonePaths, tombstoneProject } = await import("../../sync/project-tombstones.js");
      const dataDir = getLaxDir();
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

  return false;
};
