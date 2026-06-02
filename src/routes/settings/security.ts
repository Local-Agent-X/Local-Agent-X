import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeErrorMessage, corsHeaders } from "../../server-utils.js";
import { setBrowserAuthContext } from "../../browser/index.js";
import { redactCredentials } from "../../security/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.settings.security");

export const handleSecurityRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Token rotation
  if (method === "POST" && url.pathname === "/api/auth/rotate") {
    const newToken = randomBytes(32).toString("hex");
    const configPath = join(ctx.dataDir, "config.json");
    try {
      const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};
      cfg.authToken = newToken;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      ctx.config.authToken = newToken;
      ctx.rbac.rotateOperatorToken(newToken);
      setBrowserAuthContext(newToken, String(ctx.config.port));
      const masked = newToken.slice(0, 4) + "****" + newToken.slice(-4);
      logger.info(`Token rotated. New token: ${masked}`);
      json(200, { ok: true, token: newToken, message: "Token rotated. Save this token." });
    } catch { json(500, { error: "Failed to rotate token" }); }
    return true;
  }

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
    const auditDir = join(ctx.dataDir, "audit");
    if (!existsSync(auditDir)) { json(200, { lines: [] }); return true; }
    try {
      const files = readdirSync(auditDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
      const lines: string[] = [];
      for (const file of files) {
        if (lines.length >= count) break;
        const content = readFileSync(join(auditDir, file), "utf-8");
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
