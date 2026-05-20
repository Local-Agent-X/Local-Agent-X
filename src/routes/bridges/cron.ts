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
    const body = await safeParseBody(req) as { name?: string; schedule?: string; prompt?: string; systemJob?: boolean; provider?: string; model?: string };
    if (!body.name || !body.schedule || !body.prompt) { json(400, { error: "name, schedule, and prompt are required" }); return true; }
    try { json(200, { ok: true, job: ctx.cronService.create(body.name, body.schedule, body.prompt, body.systemJob, { provider: body.provider, model: body.model }) }); }
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
  // Stable "latest report" alias — used by the AGENTS sidebar to link a
  // completed mission's worker card to its most recent report. The
  // specific filename embeds a timestamp the UI doesn't know yet at
  // bg_op_completed time, so a server-side latest-resolver lets the
  // observer emit a stable URL on the completion event. Falls through
  // to 404 if no reports exist yet (e.g. first-run race where the
  // canonical op terminated but the post-canonical report-write step
  // hasn't fired yet — the UI's polling/retry will re-fetch).
  //
  // Returns rendered HTML (not the JSON wrapper the per-file route uses)
  // so clicking the link from the AGENTS sidebar opens a readable view
  // in the user's browser. The markdown is rendered server-side via a
  // tiny safe converter — no script execution, no remote fetches.
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports\/latest$/)) {
    const id = url.pathname.split("/")[3];
    const { existsSync: exists, readFileSync: readF, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const reportDir = path.join(ctx.dataDir, "cron", "reports", id);
    const send404 = () => {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>Report not found</title><body style='font-family:system-ui;padding:2rem'><h2>No report yet</h2><p>The mission ran but its report file hasn't been written yet, or no runs have completed. Try refreshing in a moment.</p>");
    };
    if (!exists(reportDir)) { send404(); return true; }
    const files = readdirSync(reportDir).filter(f => /^[\w-]+\.md$/.test(f));
    if (files.length === 0) { send404(); return true; }
    const newest = files
      .map(f => ({ f, mtime: statSync(path.join(reportDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    const md = readF(path.join(reportDir, newest.f), "utf-8");
    // Cheap & safe markdown→HTML: escape, then promote headings, bold,
    // italic, inline code, code blocks, paragraph breaks. No remote
    // includes, no script tags, no img src. Matches the conservative
    // shape of public/js/shared.js md() but kept inline so this route
    // doesn't import from public/.
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let body = esc(md);
    body = body.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _l, code) => `<pre><code>${code}</code></pre>`);
    body = body.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
    body = body.replace(/^(######)\s*(.+)$/gm, "<h6>$2</h6>");
    body = body.replace(/^(#####)\s*(.+)$/gm, "<h5>$2</h5>");
    body = body.replace(/^(####)\s*(.+)$/gm, "<h4>$2</h4>");
    body = body.replace(/^(###)\s*(.+)$/gm, "<h3>$2</h3>");
    body = body.replace(/^(##)\s*(.+)$/gm, "<h2>$2</h2>");
    body = body.replace(/^(#)\s*(.+)$/gm, "<h1>$2</h1>");
    body = body.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    body = body.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    body = body.replace(/\n\n+/g, "</p><p>");
    const html = `<!doctype html><meta charset=utf-8><title>${esc(newest.f)}</title>` +
      `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1a1a1a}` +
      `pre{background:#f4f4f6;padding:.75rem 1rem;border-radius:6px;overflow-x:auto;font-size:.9em}` +
      `code{background:#f4f4f6;padding:.1em .35em;border-radius:3px;font-size:.92em}` +
      `pre code{background:transparent;padding:0}` +
      `h1,h2,h3,h4{line-height:1.25;margin-top:1.6rem}` +
      `@media (prefers-color-scheme:dark){body{background:#16181d;color:#e6e6e6}pre,code{background:#23262c}}` +
      `</style><body><p>${body}</p>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
    return true;
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
