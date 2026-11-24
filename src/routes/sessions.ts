import type { SessionSummary } from "../broker-transport/vendor/index.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isHarnessRow } from "../harness-rows.js";
import { join } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { isValidSessionId, safeErrorMessage, safeParseBody, jsonResponse } from "../server-utils.js";
import { importSession } from "../session/export.js";
import { handleSessionReadRoutes } from "./session-read.js";
import { isExcludedFromSessionSummaries } from "../memory/synthetic-sessions.js";
import { handleSessionBranchRoutes } from "./session-branches.js";
import { isListedChat } from "../session/remove.js";
import { handleSessionRemovalRoutes } from "./session-remove.js";

/** A hit of the cross-session search: where in which chat the text was found. */
export interface SessionSearchHit {
  sessionId: string;
  title: string;
  matches: Array<{ role: string; snippet: string; index: number }>;
}

/**
 * Chats whose messages contain `query` (already lowercased): the newest 100
 * listed chats are scanned, up to 20 chats are returned, each with its first
 * five matches and a snippet around each.
 */
export function searchSessions(store: Parameters<RouteHandler>[4]["sessionStore"], query: string): SessionSearchHit[] {
  // Same hiding as the chat lists (one predicate — synthetic-sessions.ts):
  // a search hit on a cron-/dream-/eval_/skill-review- transcript opens as
  // a fake chat the sidebar refuses to list. Filter BEFORE the slice(0,100)
  // scan budget so hidden transcripts can't crowd out real ones. ide- stays
  // searchable — live user chats with their own surface.
  const allSessions = store.list().filter(isListedChat);
  const results: SessionSearchHit[] = [];
  for (const meta of allSessions.slice(0, 100)) {
    const session = store.load(meta.id);
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
  return results;
}

export const handleSessionRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // List sessions
  if (method === "GET" && url.pathname === "/api/sessions") {
    // Hide system sessions (dream, cron, IDE, eval, skill-review) from the
    // sidebar. Eval sessions are dry-run throwaways from /api/eval/run —
    // surfacing one lets the UI adopt it and route a real message into a
    // dry-run turn (silent no-op reported as success).
    // App IDE chats (ide-<appId>) are listed: they are code sessions, and the
    // sidebar's Code side shows them under their app (session/mode.ts). Their
    // `mode` says which side; the chat side never shows them.
    // Chats the user deleted are left out too: kept on disk, gone from every list (session/remove.ts).
    const all = ctx.sessionStore.list();
    // Typed as the phone's row so a renamed field fails here, not in the phone's drawer.
    const visible: SessionSummary[] = all.filter(isListedChat);
    json(200, visible);
    return true;
  }

  // Cross-session search
  if (method === "GET" && url.pathname === "/api/sessions/search") {
    const query = (url.searchParams.get("q") || "").toLowerCase().trim();
    if (!query || query.length < 2) { json(400, { error: "Query too short" }); return true; }
    const results = searchSessions(ctx.sessionStore, query);
    json(200, { results, query });
    return true;
  }

  // Get session summaries
  if (method === "GET" && url.pathname === "/api/sessions/summaries") {
    const summaryDir = join(ctx.dataDir, "memory", "session-summaries");
    if (!existsSync(summaryDir)) { json(200, { summaries: [] }); return true; }
    // Filter internal scratch (dream-/cron-/eval_/skill-review-) here too,
    // not just at the writer: summaries written before memory-bg learned to
    // skip synthetic sessions are still on disk. The predicate matches
    // filenames (`cron-x.md`) as well as raw ids. ide- summaries are real
    // user memory and stay served.
    const files = readdirSync(summaryDir).filter(f => f.endsWith(".md") && !isExcludedFromSessionSummaries(f));
    const summaries = files.map(f => {
      const content = readFileSync(join(summaryDir, f), "utf-8");
      const id = f.replace(".md", "");
      const titleMatch = content.match(/^# (.+)$/m);
      return { id, title: titleMatch?.[1] || id, summary: content.slice(0, 500) };
    });
    json(200, { summaries });
    return true;
  }

  // Sessions made from another: fork, a started chat, the fork tree (session-branches.ts)
  if (await handleSessionBranchRoutes(method, url, req, res, ctx)) return true;

  // Auto-summarize stale sessions
  if (method === "POST" && url.pathname === "/api/sessions/auto-summarize") {
    const allSessions = ctx.sessionStore.list();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Same seam as memory-bg's summarizer: internal scratch never becomes a
    // session summary (this writer shares the dir the memory index ingests).
    const stale = allSessions.filter(s => s.updatedAt < cutoff && s.messageCount > 4 && !isExcludedFromSessionSummaries(s.id));
    const summaries: Array<{ id: string; title: string; summary: string }> = [];
    const summaryDir = join(ctx.dataDir, "memory", "session-summaries");
    mkdirSync(summaryDir, { recursive: true });
    for (const meta of stale.slice(0, 20)) {
      const summaryFile = join(summaryDir, `${meta.id}.md`);
      if (existsSync(summaryFile)) continue;
      const session = ctx.sessionStore.load(meta.id);
      if (!session) continue;
      const userMsgs = session.messages.filter(m => m.role === "user" && typeof m.content === "string" && !isHarnessRow(m));
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

  // Reading one stored session out: its export, its messages page by page.
  if (await handleSessionReadRoutes(method, url, req, res, ctx)) return true;

  if (method === "POST" && url.pathname === "/api/sessions/import") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      json(200, await importSession(body as unknown as string)); return true;
    } catch (e) { json(400, { error: safeErrorMessage(e) }); return true; }
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

  // Get session — UI projection by default (drops tool rows + tool_calls so
  // chat.js renders the conversation cleanly). Pass `?view=raw` for the
  // rich form (debug/admin/replay only). Model-side code paths
  // (`prepareAgentRequest`, `seedOpMessages`) never call this endpoint —
  // they read the rich session directly via the session store.
  if (method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return true; }
    const raw = url.searchParams.get("view") === "raw";
    await ctx.flushSession(id);
    // Read time (server clock), taken before the read: a client echoes it as
    // subscribe's historyAsOf so the chat replay skips a turn this history
    // already holds (chat-ws/replay.ts).
    const asOf = Date.now();
    const session = ctx.getOrCreateSession(id);
    if (raw) { json(200, session); return true; }
    json(200, { ...ctx.sessionStore.projectForUI(session), asOf });
    return true;
  }

  // Delete, erase, start fresh (session-remove.ts).
  return handleSessionRemovalRoutes(method, url, req, res, ctx, role);
};
