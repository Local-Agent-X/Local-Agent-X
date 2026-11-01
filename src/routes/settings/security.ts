import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeErrorMessage, corsHeaders } from "../../server-utils.js";
import { redactCredentials } from "../../security/index.js";
import { listAuditFiles } from "../../threat/audit-crypto.js";

export const handleSecurityRoutes: RouteHandler = async (method, url, req, res, ctx) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // History export
  if (method === "GET" && url.pathname === "/api/history") {
    const sessions = ctx.sessionStore.list();
    json(200, { sessions: sessions.map(s => ({ id: s.id, title: s.title, messageCount: s.messageCount, updatedAt: s.updatedAt })), exportedAt: Date.now() });
    return true;
  }
  if (method === "GET" && url.pathname.startsWith("/api/history/")) {
    const id = url.pathname.split("/").pop()!;
    await ctx.flushSession(id);
    const session = ctx.getOrCreateSession(id);
    const redacted = session.messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? redactCredentials(m.content) : m.content }));
    json(200, { ...session, messages: redacted }); return true;
  }

  // SIEM log export
  if (method === "GET" && url.pathname === "/api/logs/export") {
    const count = parseInt(url.searchParams.get("count") || "100", 10);
    const files = listAuditFiles(join(ctx.dataDir, "audit"));
    if (files.length === 0) { json(200, { lines: [] }); return true; }
    try {
      const lines: string[] = [];
      for (const file of files) {
        if (lines.length >= count) break;
        const content = readFileSync(file.path, "utf-8");
        const fileLines = content.split("\n").filter(l => l.trim());
        lines.push(...fileLines.slice(-(count - lines.length)));
      }
      res.writeHead(200, { ...corsHeaders(req), "Content-Type": "application/x-ndjson" });
      res.end(lines.join("\n"));
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
