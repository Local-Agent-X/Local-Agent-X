import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";

export const handleCronRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Scheduled Missions ──
  if (method === "GET" && (url.pathname === "/api/missions" || url.pathname === "/api/cron" || url.pathname === "/api/schedules")) {
    const jobs = ctx.cronService.list();
    const missions = jobs.map(j => ({
      ...j,
      nextRunAt: ctx.cronService.getNextRunAt(j),
      isRunning: ctx.cronService.isRunning(j.id),
    }));
    json(200, { missions, settings: ctx.cronService.getSettings() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/cron") {
    const body = await safeParseBody(req) as { name?: string; schedule?: string; prompt?: string; systemJob?: boolean };
    if (!body.name || !body.schedule || !body.prompt) { json(400, { error: "name, schedule, and prompt are required" }); return true; }
    try { json(200, { ok: true, job: ctx.cronService.create(body.name, body.schedule, body.prompt, body.systemJob) }); }
    catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "PATCH" && url.pathname.startsWith("/api/cron/")) {
    const id = url.pathname.split("/").pop()!;
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try {
      const job = ctx.cronService.update(id, body);
      if (!job) { json(404, { error: "Job not found" }); return true; }
      json(200, { ok: true, job });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "DELETE" && url.pathname.match(/^\/api\/cron\/[^/]+$/)) {
    json(200, { ok: true, deleted: ctx.cronService.delete(url.pathname.split("/").pop()!) }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/toggle$/)) {
    const job = ctx.cronService.toggle(url.pathname.split("/")[3]);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    json(200, { ok: true, job }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/run$/)) {
    const id = url.pathname.split("/")[3];
    const job = ctx.cronService.get(id);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    json(200, { ok: true, message: `Job "${job.name}" triggered` });
    ctx.cronService.executeJob(job, { manual: true }).catch(() => {});
    return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/cancel$/)) {
    const id = url.pathname.split("/")[3];
    if (!ctx.cronService.get(id)) { json(404, { error: "Job not found" }); return true; }
    const cancelled = ctx.cronService.cancelRun(id);
    json(200, { ok: true, cancelled });
    return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/clear-error$/)) {
    const id = url.pathname.split("/")[3];
    const cleared = ctx.cronService.clearLastError(id);
    if (!cleared) { json(404, { error: "Job not found" }); return true; }
    json(200, { ok: true, job: ctx.cronService.get(id) });
    return true;
  }
  // Per-job run history (newest first)
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/history$/)) {
    const id = url.pathname.split("/")[3];
    const job = ctx.cronService.get(id);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50") || 50, 200);
    json(200, { runs: ctx.cronService.listHistory(id, limit) });
    return true;
  }
  // Live status of a cron job — includes any active sub-agents for this job
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/status$/)) {
    const id = url.pathname.split("/")[3];
    const job = ctx.cronService.get(id);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    const running = ctx.cronService.isRunning(id);
    const nextRunAt = ctx.cronService.getNextRunAt(job);
    let subAgents: Array<{ id: string; name: string; role: string; status: string; currentTask?: string; tokensUsed: number; elapsed: number; recentTools: string[] }> = [];
    try {
      const { Handler } = await import("../../agency/handler.js");
      const handler = Handler.getInstance();
      const agentsRaw = (handler as unknown as { agents: Map<string, { id: string; name: string; role: string; status: string; currentTask?: string; tokensUsed: number; startedAt: number; parentSessionId?: string; output: string[] }> }).agents;
      // Find sub-agents whose parentSessionId starts with cron-{id}
      const children = [...agentsRaw.values()].filter(a => a.parentSessionId?.startsWith(`cron-${id}-`));
      subAgents = children.map(a => {
        // Extract recent tool activity from output log (entries starting with [tool])
        const recentTools = a.output
          .filter(l => typeof l === "string" && l.startsWith("[tool] "))
          .slice(-5)
          .map(l => l.slice(7).replace(/\.\.\.$/, ""));
        return {
          id: a.id, name: a.name, role: a.role, status: a.status,
          currentTask: a.currentTask, tokensUsed: a.tokensUsed,
          elapsed: Date.now() - a.startedAt, recentTools,
        };
      });
    } catch {}
    json(200, { running, job, nextRunAt, subAgents }); return true;
  }
  if (method === "POST" && url.pathname === "/api/cron/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.cronService.updateSettings(body);
    json(200, { ok: true, settings: ctx.cronService.getSettings() }); return true;
  }
  // Cron reports
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports$/)) {
    const id = url.pathname.split("/")[3];
    const { existsSync: exists, readdirSync } = await import("node:fs");
    const reportDir = (await import("node:path")).join(ctx.dataDir, "cron", "reports", id);
    if (!exists(reportDir)) { json(200, { reports: [] }); return true; }
    const files = readdirSync(reportDir).filter(f => f.endsWith(".md")).sort().reverse();
    json(200, { reports: files.map(f => ({ name: f, path: `/api/cron/${id}/reports/${f}` })) }); return true;
  }
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports\/[^/]+\.md$/)) {
    const parts = url.pathname.split("/");
    const id = parts[3], file = parts[5];
    if (!/^[\w-]+\.md$/.test(file)) { json(400, { error: "Invalid file name" }); return true; }
    const { existsSync: exists, readFileSync: readF } = await import("node:fs");
    const reportPath = (await import("node:path")).join(ctx.dataDir, "cron", "reports", id, file);
    if (!exists(reportPath)) { json(404, { error: "Report not found" }); return true; }
    json(200, { content: readF(reportPath, "utf-8") }); return true;
  }
  // Delete a single report (removes from both .lax/cron/reports and workspace/missions mirror)
  if (method === "DELETE" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports\/[^/]+\.md$/)) {
    const parts = url.pathname.split("/");
    const id = parts[3], file = parts[5];
    if (!/^[\w-]+\.md$/.test(file)) { json(400, { error: "Invalid file name" }); return true; }
    const { existsSync: exists, unlinkSync } = await import("node:fs");
    const path = await import("node:path");
    const job = ctx.cronService.get(id);
    const primary = path.join(ctx.dataDir, "cron", "reports", id, file);
    let deleted = 0;
    if (exists(primary)) { try { unlinkSync(primary); deleted++; } catch {} }
    if (job) {
      const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const mirror = path.join(path.resolve(ctx.config.workspace), "missions", slug, file);
      if (exists(mirror)) { try { unlinkSync(mirror); deleted++; } catch {} }
    }
    json(200, { ok: true, deleted }); return true;
  }

  return false;
};
