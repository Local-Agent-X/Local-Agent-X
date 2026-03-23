import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import { allTools } from "./tools.js";
import { SecurityLayer } from "./security.js";
import { getApiKey } from "./auth.js";
import type { SAXConfig, ServerEvent, Session } from "./types.js";

// In-memory session store (v1 — persist to disk later)
const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      title: "New Mission",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.set(id, session);
  }
  return session;
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });
  res.end(JSON.stringify(data));
}

function sseWrite(res: ServerResponse, event: ServerEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function startServer(config: SAXConfig) {
  const security = new SecurityLayer(config.workspace);
  const publicDir = join(import.meta.dirname || ".", "..", "public");

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    const method = req.method || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // Auth check (skip for dashboard static files)
    if (url.pathname.startsWith("/api/")) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${config.authToken}`) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    // ── Routes ──

    // Health
    if (method === "GET" && url.pathname === "/api/health") {
      jsonResponse(res, 200, { status: "ok", version: "0.1.0" });
      return;
    }

    // List sessions
    if (method === "GET" && url.pathname === "/api/sessions") {
      const list = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      jsonResponse(res, 200, list);
      return;
    }

    // Get session
    if (method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      const session = sessions.get(id);
      if (!session) {
        jsonResponse(res, 404, { error: "Session not found" });
        return;
      }
      jsonResponse(res, 200, session);
      return;
    }

    // Delete session
    if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      sessions.delete(id);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // Chat (SSE streaming)
    if (method === "POST" && url.pathname === "/api/chat") {
      const body = JSON.parse(await readBody(req));
      const { message, sessionId = "default" } = body as {
        message: string;
        sessionId?: string;
      };

      if (!message) {
        jsonResponse(res, 400, { error: "message is required" });
        return;
      }

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const session = getOrCreateSession(sessionId);

      // Auto-title from first message
      if (session.messages.length === 0) {
        session.title = message.slice(0, 60) + (message.length > 60 ? "..." : "");
      }

      try {
        const apiKey = await getApiKey(config.openaiApiKey);

        // Detect provider: if OAuth tokens exist use codex, otherwise check for xAI key
        const { loadTokens } = await import("./auth.js");
        const tokens = loadTokens();
        const provider = tokens && !config.openaiApiKey ? "codex" as const : "xai" as const;

        const result = await runAgent(message, session.messages, {
          apiKey,
          model: provider === "codex" ? "gpt-5.3-codex" : config.model,
          provider,
          systemPrompt: config.systemPrompt,
          tools: allTools,
          security,
          maxIterations: config.maxIterations,
          temperature: config.temperature,
          onEvent: (event) => sseWrite(res, event),
        });

        // Update session with new messages (skip system prompt)
        session.messages = result.messages.filter((m) => m.role !== "system");
        session.updatedAt = Date.now();
      } catch (e) {
        sseWrite(res, { type: "error", message: (e as Error).message });
      }

      res.end();
      return;
    }

    // OAuth login trigger
    if (method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const { startOAuthLogin } = await import("./auth.js");
        await startOAuthLogin();
        jsonResponse(res, 200, { ok: true });
      } catch (e) {
        jsonResponse(res, 500, { error: (e as Error).message });
      }
      return;
    }

    // Auth status
    if (method === "GET" && url.pathname === "/api/auth/status") {
      const { loadTokens } = await import("./auth.js");
      const tokens = loadTokens();
      jsonResponse(res, 200, {
        authenticated: !!tokens || !!config.openaiApiKey,
        method: config.openaiApiKey ? "api_key" : tokens ? "oauth" : "none",
      });
      return;
    }

    // Serve dashboard
    if (method === "GET") {
      let filePath: string;
      if (url.pathname === "/" || url.pathname === "/index.html") {
        filePath = join(publicDir, "index.html");
      } else {
        filePath = join(publicDir, url.pathname);
      }

      if (existsSync(filePath)) {
        const ext = filePath.split(".").pop() || "";
        const contentTypes: Record<string, string> = {
          html: "text/html",
          css: "text/css",
          js: "application/javascript",
          json: "application/json",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
        };
        res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
        res.end(readFileSync(filePath));
        return;
      }
    }

    // 404
    jsonResponse(res, 404, { error: "Not found" });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`\n  Secret Agent X running at http://127.0.0.1:${config.port}`);
    console.log(`  Auth token: ${config.authToken}\n`);
  });

  return server;
}
