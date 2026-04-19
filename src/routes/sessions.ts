import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RouteHandler } from "../server-context.js";
import { isValidSessionId, safeErrorMessage, readBody, safeParseBody, jsonResponse } from "../server-utils.js";
import { exportSession, importSession } from "../session-export.js";
import { loadSessionPage } from "../progressive-loader.js";

export const handleSessionRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // List sessions
  if (method === "GET" && url.pathname === "/api/sessions") {
    // Hide system sessions (dream, cron, IDE) from the sidebar
    const all = ctx.sessionStore.list();
    const visible = all.filter(s => !s.id.startsWith("dream-") && !s.id.startsWith("cron-") && !s.id.startsWith("ide-"));
    json(200, visible);
    return true;
  }

  // Cross-session search
  if (method === "GET" && url.pathname === "/api/sessions/search") {
    const query = (url.searchParams.get("q") || "").toLowerCase().trim();
    if (!query || query.length < 2) { json(400, { error: "Query too short" }); return true; }
    const allSessions = ctx.sessionStore.list();
    const results: Array<{ sessionId: string; title: string; matches: Array<{ role: string; snippet: string; index: number }> }> = [];
    for (const meta of allSessions.slice(0, 100)) {
      const session = ctx.sessionStore.load(meta.id);
      if (!session) continue;
      const matches: Array<{ role: string; snippet: string; index: number }> = [];
      for (let i = 0; i < session.messages.length; i++) {
        const m = session.messages[i];
        const content = typeof m.content === "string" ? m.content : "";
        const idx = content.toLowerCase().indexOf(query);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(content.length, idx + query.length + 100);
          matches.push({ role: m.role as string, snippet: content.slice(start, end), index: i });
        }
      }
      if (matches.length > 0) {
        results.push({ sessionId: meta.id, title: session.title, matches: matches.slice(0, 5) });
      }
      if (results.length >= 20) break;
    }
    json(200, { results, query });
    return true;
  }

  // Get session summaries
  if (method === "GET" && url.pathname === "/api/sessions/summaries") {
    const summaryDir = join(ctx.dataDir, "memory", "session-summaries");
    if (!existsSync(summaryDir)) { json(200, { summaries: [] }); return true; }
    const files = readdirSync(summaryDir).filter(f => f.endsWith(".md"));
    const summaries = files.map(f => {
      const content = readFileSync(join(summaryDir, f), "utf-8");
      const id = f.replace(".md", "");
      const titleMatch = content.match(/^# (.+)$/m);
      return { id, title: titleMatch?.[1] || id, summary: content.slice(0, 500) };
    });
    json(200, { summaries });
    return true;
  }

  // Fork session
  if (method === "POST" && url.pathname === "/api/sessions/fork") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const sourceId = String(body.sessionId || "");
    const atIndex = typeof body.atIndex === "number" ? body.atIndex : -1;
    if (!sourceId || !isValidSessionId(sourceId)) { json(400, { error: "Invalid session ID" }); return true; }
    const source = ctx.getOrCreateSession(sourceId);
    if (atIndex < 0 || atIndex >= source.messages.length) { json(400, { error: "Invalid message index" }); return true; }
    const forkId = `fork-${randomBytes(8).toString("hex")}`;
    const forkedMessages = source.messages.slice(0, atIndex + 1);
    const forkSession = {
      id: forkId, title: `Fork: ${source.title}`,
      messages: JSON.parse(JSON.stringify(forkedMessages)),
      createdAt: Date.now(), updatedAt: Date.now(),
      forkedFrom: sourceId,
      forkAtIndex: atIndex,
    };
    ctx.saveSession(forkSession);
    json(200, { ok: true, forkId, title: forkSession.title, messageCount: forkedMessages.length });
    return true;
  }

  // Get fork tree
  if (method === "GET" && url.pathname === "/api/sessions/forks") {
    const sourceId = url.searchParams.get("sessionId") || "";
    if (!sourceId) { json(400, { error: "sessionId required" }); return true; }
    const allSessions = ctx.sessionStore.list();
    const forks: Array<{ id: string; title: string; forkAtIndex: number; createdAt: number }> = [];
    for (const meta of allSessions) {
      const s = ctx.sessionStore.load(meta.id);
      if (s && s.forkedFrom === sourceId) {
        forks.push({ id: s.id, title: s.title, forkAtIndex: s.forkAtIndex || 0, createdAt: s.createdAt });
      }
    }
    const thisSession = ctx.sessionStore.load(sourceId);
    const parent = thisSession?.forkedFrom || null;
    json(200, { forks, parent });
    return true;
  }

  // Auto-summarize stale sessions
  if (method === "POST" && url.pathname === "/api/sessions/auto-summarize") {
    const allSessions = ctx.sessionStore.list();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stale = allSessions.filter(s => s.updatedAt < cutoff && s.messageCount > 4);
    const summaries: Array<{ id: string; title: string; summary: string }> = [];
    const summaryDir = join(ctx.dataDir, "memory", "session-summaries");
    mkdirSync(summaryDir, { recursive: true });
    for (const meta of stale.slice(0, 20)) {
      const summaryFile = join(summaryDir, `${meta.id}.md`);
      if (existsSync(summaryFile)) continue;
      const session = ctx.sessionStore.load(meta.id);
      if (!session) continue;
      const userMsgs = session.messages.filter(m => m.role === "user" && typeof m.content === "string");
      const assistMsgs = session.messages.filter(m => m.role === "assistant" && typeof m.content === "string");
      const topicLines = userMsgs.slice(0, 5).map(m => `- User: ${String(m.content).slice(0, 120)}`);
      const assistLines = assistMsgs.slice(0, 3).map(m => `- Agent: ${String(m.content).split("\n")[0]?.slice(0, 120)}`);
      const summary = `# ${session.title}\n\nDate: ${new Date(session.createdAt).toISOString().split("T")[0]}\nMessages: ${session.messages.length}\n\n## Key Topics\n${topicLines.join("\n")}\n\n## Key Responses\n${assistLines.join("\n")}`;
      writeFileSync(summaryFile, summary, "utf-8");
      summaries.push({ id: meta.id, title: session.title, summary });
    }
    json(200, { ok: true, summarized: summaries.length, total: stale.length, summaries });
    return true;
  }

  // Get single session
  if (method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/export")) {
    const id = url.pathname.split("/")[3];
    const format = (url.searchParams.get("format") || "json") as "json" | "markdown";
    try {
      json(200, exportSession(ctx.dataDir, id, format)); return true;
    } catch (e) { json(404, { error: safeErrorMessage(e) }); return true; }
  }

  if (method === "POST" && url.pathname === "/api/sessions/import") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      json(200, await importSession(body as unknown as string)); return true;
    } catch (e) { json(400, { error: safeErrorMessage(e) }); return true; }
  }

  // Progressive loading
  if (method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
    const id = url.pathname.split("/")[3];
    const page = parseInt(url.searchParams.get("page") || "0");
    const pageSize = parseInt(url.searchParams.get("pageSize") || "50");
    try {
      json(200, await loadSessionPage(id, page, pageSize)); return true;
    } catch (e) { json(404, { error: safeErrorMessage(e) }); return true; }
  }

  // Rename session (PATCH)
  if (method === "PATCH" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    const body = await safeParseBody(req);
    if (!body || typeof body.title !== "string") { json(400, { error: "title (string) required" }); return true; }
    const session = ctx.sessionStore.load(id);
    if (!session) { json(404, { error: "Session not found" }); return true; }
    session.title = body.title;
    session.updatedAt = Date.now();
    ctx.saveSession(session);
    json(200, { ok: true, id, title: session.title });
    return true;
  }

  // Get session
  if (method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    json(200, ctx.getOrCreateSession(id));
    return true;
  }

  // Delete ALL sessions (clear sidebar). Destructive — wipes every session
  // JSON on disk. Memory (MIND.md, facts, chunks) is untouched.
  if (method === "DELETE" && url.pathname === "/api/sessions") {
    const all = ctx.sessionStore.list();
    let deleted = 0;
    for (const s of all) {
      try { ctx.sessionStore.delete(s.id); deleted++; } catch {}
    }
    json(200, { ok: true, deleted });
    return true;
  }

  // Delete session
  if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    ctx.sessionStore.delete(id);
    json(200, { ok: true });
    return true;
  }

  return false;
};
