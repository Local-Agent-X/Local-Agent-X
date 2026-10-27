import type { RouteHandler, ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import type { Project } from "../../agent-store/index.js";
import { seedProjectRosters } from "../../project-rosters.js";
import { createLogger } from "../../logger.js";
import { codeSessionFolder } from "../../session/code-work-root.js";
import { basename, dirname, resolve } from "node:path";

const logger = createLogger("routes.agents.projects");

/** Push a projects_changed event to every connected client. The frontend
 *  WS handler (public/js/chat-ws-handler.js) reacts by re-rendering both
 *  the Agents-page dropdown (loadProjects) and the chat sidebar
 *  (syncProjectsFromServer). Same pattern as the project_create tool
 *  uses. Best-effort: a missing chat-ws import (tests, scripts) doesn't
 *  fail the route. */
async function broadcastProjectsChanged(): Promise<void> {
  try {
    const { broadcastAll } = await import("../../chat-ws/index.js");
    broadcastAll({ type: "projects_changed" });
  } catch { /* no WS context — request itself still succeeded */ }
}

export const handleProjectRoutes: RouteHandler = async (method, url, req, res, ctx: ServerContext, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "POST" && url.pathname === "/api/projects/from-starter") {
    const body = await safeParseBody(req);
    if (!body || !body.name) { json(400, { error: "name required" }); return true; }
    const dup = ctx.projectStore.findByName(body.name as string);
    if (dup) { json(409, { error: `Project name '${body.name}' already exists`, existingId: dup.id, existing: dup }); return true; }
    const project = ctx.projectStore.create({ name: body.name as string, description: (body.description as string) || "", agentIds: (body.agentIds as string[]) || [], workspace: body.workspace as string | undefined });
    await seedProjectRosters(project.id, (body.agentIds as string[]) || [], ctx.projectStore);
    await broadcastProjectsChanged();
    json(200, project); return true;
  }

  // The phone's Code side (broker-transport/device-paths.ts): the code folders,
  // and adding one, with nothing else of a project in or out.
  if (method === "GET" && url.pathname === "/api/code-folders") {
    json(200, ctx.projectStore.list().filter((p) => p.codeFolder).map(codeFolderView)); return true;
  }
  if (method === "POST" && url.pathname === "/api/code-folders") {
    const body = await safeParseBody(req);
    const folder = codeSessionFolder(typeof body?.workspace === "string" ? body.workspace : undefined);
    if (!folder) { json(400, { error: "That is not a folder on this computer." }); return true; }
    json(200, codeFolderView(await codeFolderProject(folder, ctx.projectStore))); return true;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    json(200, ctx.projectStore.list()); return true;
  }
  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await safeParseBody(req);
    if (body?.codeFolder === true) { await createCodeFolder(body, ctx, json); return true; }
    if (!body || !body.name) { json(400, { error: "name required" }); return true; }
    const dup = ctx.projectStore.findByName(body.name as string);
    if (dup) { json(409, { error: `Project name '${body.name}' already exists`, existingId: dup.id, existing: dup }); return true; }
    const project = ctx.projectStore.create({ name: body.name as string, description: (body.description as string) || "", workspace: body.workspace as string | undefined, agentIds: (body.agentIds as string[]) || [], secretKeys: body.secretKeys as string[] | undefined, allowedTools: body.allowedTools as string[] | undefined });
    // Mirror from-starter — any seeded agentIds become real roster entries
    // (the L3 source of truth). Without this, a project created with
    // agentIds:[...] looked populated on disk but had zero hires for the
    // Team tab / org chart / membership reads.
    await seedProjectRosters(project.id, (body.agentIds as string[]) || [], ctx.projectStore);
    await broadcastProjectsChanged();
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
    await broadcastProjectsChanged();
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
    if (deleted) {
      try { ctx.agentSync.notifyChange(`project-delete:${id}`); } catch {}
      await broadcastProjectsChanged();
    }
    json(deleted ? 200 : 404, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/projects\/proj-[^/]+\/agents$/)) {
    const id = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || !body.agentId) { json(400, { error: "agentId required" }); return true; }
    const ok = ctx.projectStore.addAgent(id, body.agentId as string);
    if (ok) await broadcastProjectsChanged();
    json(ok ? 200 : 404, { ok: true }); return true;
  }
  if (method === "DELETE" && url.pathname.match(/^\/api\/projects\/proj-[^/]+\/agents$/)) {
    const id = url.pathname.split("/")[3];
    const body = await safeParseBody(req);
    if (!body || !body.agentId) { json(400, { error: "agentId required" }); return true; }
    const ok = ctx.projectStore.removeAgent(id, body.agentId as string);
    if (ok) await broadcastProjectsChanged();
    json(ok ? 200 : 404, { ok: true }); return true;
  }

  return false;
};

/**
 * POST /api/projects with `codeFolder: true`: the sidebar's Code side adding a
 * folder. The folder must be a real directory; adding one that is already a
 * code folder returns it, and a name another project holds gets the parent
 * folder's name beside it, so two checkouts called `app` can both be added.
 */
async function createCodeFolder(
  body: Record<string, unknown>,
  ctx: ServerContext,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const folder = codeSessionFolder(typeof body.workspace === "string" ? body.workspace : undefined);
  if (!folder) { json(400, { error: "That is not a folder on this computer." }); return; }
  json(200, await codeFolderProject(folder, ctx.projectStore));
}

/** A code folder as /api/code-folders shows it: what a session is filed under. */
function codeFolderView(p: Project): { id: string; name: string; workspace: string } {
  return { id: p.id, name: p.name, workspace: p.workspace ?? "" };
}

/** The code-folder project for `folder` (a real directory): the one already on
 *  the sidebar, or a new one. Shared by the sidebar's add-folder and a chat
 *  continuing in Code mode on the repo it worked in (sessions-fork.ts). */
export async function codeFolderProject(folder: string, store: ServerContext["projectStore"]): Promise<Project> {
  const same = (p: Project) => p.codeFolder && p.workspace && resolve(p.workspace).toLowerCase() === resolve(folder).toLowerCase();
  const existing = store.list().find(same);
  if (existing) return existing;
  const base = basename(folder) || folder;
  let name = base;
  if (store.findByName(name)) name = `${base} (${basename(dirname(folder)) || "folder"})`;
  for (let n = 2; store.findByName(name); n++) name = `${base} ${n}`;
  const project = store.create({ name, description: "", workspace: folder, codeFolder: true, agentIds: [] });
  await broadcastProjectsChanged();
  return project;
}
