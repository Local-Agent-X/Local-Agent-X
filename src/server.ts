import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { runAgent } from "./agent.js";
import { allTools, createHttpRequestTool } from "./tools.js";
import { SecurityLayer } from "./security.js";
import { loadToolPolicy } from "./tool-policy.js";
import { getApiKey } from "./auth.js";
import {
  SessionStore,
  MemoryIndex,
  createMemoryTools,
  buildContextBlock,
  autoSearchContext,
  autoExtractAndSave,
  ensurePersonalityFiles,
} from "./memory.js";
import { SecretsStore } from "./secrets.js";
import { createSecretTools } from "./secret-tools.js";
import { ThreatEngine } from "./threat-engine.js";
import { createBrowserTools, closeBrowser } from "./browser-tools.js";
import { closeAllBrowsers } from "./browser.js";
import { redactCredentials } from "./security.js";
import type { SAXConfig, ServerEvent, Session } from "./types.js";

// Session ID validation: alphanumeric + dash/underscore, max 64 chars
function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// ── CORS: loopback-only for mutations ──

const LOOPBACK_ORIGINS = new Set([
  "http://localhost",
  "http://127.0.0.1",
  "http://[::1]",
]);

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // No origin = non-browser client (curl, etc.) → allow
  try {
    const parsed = new URL(origin);
    const base = `${parsed.protocol}//${parsed.hostname}`;
    return LOOPBACK_ORIGINS.has(base);
  } catch {
    return false;
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  // Only reflect origin if it's from loopback
  if (origin && isLoopbackOrigin(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Vary": "Origin",
    };
  }
  // No CORS headers for non-loopback origins → browser blocks the request
  return {};
}

function jsonResponse(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(req ? corsHeaders(req) : {}),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

// ── Rate Limiting: token bucket per IP ──

const rateLimits = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_MAX = 30;          // max burst
const RATE_LIMIT_REFILL_PER_SEC = 2; // tokens per second

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateLimits.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_MAX, lastRefill: now };
    rateLimits.set(ip, bucket);
  }
  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_MAX, bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) return false; // rate limited
  bucket.tokens -= 1;
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [ip, bucket] of rateLimits) {
    if (bucket.lastRefill < cutoff) rateLimits.delete(ip);
  }
}, 300_000);

function sseWrite(res: ServerResponse, event: ServerEvent) {
  // Redact credentials from tool output before streaming to client
  if (event.type === "tool_end" && event.result) {
    event = { ...event, result: redactCredentials(event.result) };
  }
  if (event.type === "stream" && event.delta) {
    event = { ...event, delta: redactCredentials(event.delta) };
  }
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
  const dataDir = join(homedir(), ".sax");
  const toolPolicy = loadToolPolicy(dataDir);

  // Initialize memory systems
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  const memoryTools = createMemoryTools(memoryIndex);

  // Create personality files on first run
  ensurePersonalityFiles(join(dataDir, "memory"));

  // Initialize secrets store
  const secretsStore = new SecretsStore(dataDir);

  // Mutable ref so secret tools can emit SSE events during the active request
  let activeOnEvent: ((event: ServerEvent) => void) | undefined;
  const secretTools = createSecretTools(secretsStore, undefined);
  // Patch request_secret to use the active SSE writer
  const origExecute = secretTools[0].execute;
  secretTools[0].execute = async (args, signal) => {
    const { createSecretTools: factory } = await import("./secret-tools.js");
    const patched = factory(secretsStore, activeOnEvent);
    return patched[0].execute(args, signal);
  };

  // HTTP request tool with secrets resolution
  const httpRequestTool = createHttpRequestTool(secretsStore);

  // Combine all tools
  // Browser tools — session ID passed via getter (thread-safe, no global state)
  let activeBrowserSessionId = "default";
  const browserTools = createBrowserTools(() => activeBrowserSessionId);

  const tools = [...allTools, httpRequestTool, ...memoryTools, ...secretTools, ...browserTools];

  // In-memory session cache (backed by disk)
  const sessions = new Map<string, Session>();

  function getOrCreateSession(id: string): Session {
    // Try cache first
    let session = sessions.get(id);
    if (session) return session;

    // Try disk
    session = sessionStore.load(id) ?? undefined;
    if (session) {
      sessions.set(id, session);
      return session;
    }

    // Create new
    session = {
      id,
      title: "New Mission",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.set(id, session);
    return session;
  }

  function saveSession(session: Session): void {
    sessions.set(session.id, session);
    sessionStore.save(session);
    memoryIndex.markDirty(); // Trigger re-index on next search
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    const method = req.method || "GET";

    // Helper: jsonResponse with req always bound for CORS
    const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

    // CORS preflight — only allow loopback origins
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    // CSRF guard: block cross-origin mutations
    if (url.pathname.startsWith("/api/") && method !== "GET") {
      const origin = req.headers.origin;
      const secFetchSite = req.headers["sec-fetch-site"];

      // If browser sends Sec-Fetch-Site: cross-site, block immediately
      if (secFetchSite === "cross-site") {
        jsonResponse(res, 403, { error: "Cross-origin mutation blocked" }, req);
        return;
      }

      // If Origin header present, must be loopback
      if (origin && !isLoopbackOrigin(origin)) {
        jsonResponse(res, 403, { error: "Cross-origin request blocked" }, req);
        return;
      }
    }

    // Rate limiting on API endpoints
    if (url.pathname.startsWith("/api/")) {
      const clientIp = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(clientIp)) {
        jsonResponse(res, 429, { error: "Rate limit exceeded. Try again shortly." }, req);
        return;
      }
    }

    // Auth check (skip for static files) — timing-safe comparison
    if (url.pathname.startsWith("/api/")) {
      const auth = req.headers.authorization || "";
      const expected = `Bearer ${config.authToken}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      const isValid = authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
      if (!isValid) {
        jsonResponse(res, 401, { error: "Unauthorized" }, req);
        return;
      }
    }

    // ── Routes ──

    // Health
    if (method === "GET" && url.pathname === "/api/health") {
      const memStats = memoryIndex.getStats();
      json(200, {
        status: "ok",
        version: "0.1.0",
        memory: memStats,
      });
      return;
    }

    // List sessions
    if (method === "GET" && url.pathname === "/api/sessions") {
      const list = sessionStore.list();
      json(200, list);
      return;
    }

    // Get session
    if (method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      if (!isValidSessionId(id)) {
        json(400, { error: "Invalid session ID" });
        return;
      }
      const session = getOrCreateSession(id);
      json(200, session);
      return;
    }

    // Delete session
    if (method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      if (!isValidSessionId(id)) {
        json(400, { error: "Invalid session ID" });
        return;
      }
      sessions.delete(id);
      sessionStore.delete(id);
      json(200, { ok: true });
      return;
    }

    // Memory search API
    if (method === "GET" && url.pathname === "/api/memory/search") {
      const query = url.searchParams.get("q") || "";
      if (!query) {
        json(400, { error: "q parameter required" });
        return;
      }
      const results = await memoryIndex.search(query);
      json(200, results);
      return;
    }

    // Memory stats
    if (method === "GET" && url.pathname === "/api/memory/stats") {
      json(200, memoryIndex.getStats());
      return;
    }

    // Memory recall (entity/temporal/kind queries)
    if (method === "GET" && url.pathname === "/api/memory/recall") {
      const entity = url.searchParams.get("entity") || undefined;
      const kind = url.searchParams.get("kind") as import("./memory.js").FactKind | undefined;
      const since = url.searchParams.get("since");

      let facts;
      if (entity) {
        facts = memoryIndex.recallByEntity(entity);
      } else if (kind) {
        facts = memoryIndex.recallByKind(kind);
      } else if (since) {
        facts = memoryIndex.recallByTime(new Date(since));
      } else {
        json(400, { error: "Provide entity, kind, or since parameter" });
        return;
      }
      json(200, facts);
      return;
    }

    // Memory reflect (trigger reflection cycle)
    if (method === "POST" && url.pathname === "/api/memory/reflect") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(400, { error: "Invalid JSON body" });
        return;
      }
      const sinceDays = (body.since_days as number) || 7;
      const result = await memoryIndex.reflect(sinceDays);
      json(200, result);
      return;
    }

    // ── Secrets API ──

    // List secrets (names + metadata only, never values)
    if (method === "GET" && url.pathname === "/api/secrets") {
      json(200, secretsStore.list());
      return;
    }

    // Add or update a secret
    if (method === "POST" && url.pathname === "/api/secrets") {
      const body = JSON.parse(await readBody(req)) as {
        name?: string;
        value?: string;
        service?: string;
      };
      const name = body.name?.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!name || !body.value) {
        json(400, { error: "name and value are required" });
        return;
      }
      secretsStore.set(name, body.value, body.service);
      json(200, { ok: true, name });
      return;
    }

    // Delete a secret
    if (method === "DELETE" && url.pathname.startsWith("/api/secrets/")) {
      const name = decodeURIComponent(url.pathname.split("/").pop()!);
      const existed = secretsStore.delete(name);
      json(200, { ok: true, deleted: existed });
      return;
    }

    // Chat (SSE streaming)
    if (method === "POST" && url.pathname === "/api/chat") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(400, { error: "Invalid JSON body" });
        return;
      }
      const message = body.message as string | undefined;
      const sessionId = (body.sessionId as string) || "default";

      if (!message) {
        json(400, { error: "message is required" });
        return;
      }

      if (!isValidSessionId(sessionId)) {
        json(400, { error: "Invalid session ID" });
        return;
      }

      // SSE headers — CORS restricted to loopback
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(req),
      });

      const session = getOrCreateSession(sessionId);

      // Auto-title from first message
      if (session.messages.length === 0) {
        session.title = message.slice(0, 60) + (message.length > 60 ? "..." : "");
      }

      try {
        const apiKey = await getApiKey(config.openaiApiKey);

        // Detect provider
        const { loadTokens } = await import("./auth.js");
        const tokens = loadTokens();
        const provider = tokens && !config.openaiApiKey ? ("codex" as const) : ("xai" as const);

        // Wire up SSE writer so request_secret can emit to the active stream
        const onEvent = (event: ServerEvent) => sseWrite(res, event);
        activeOnEvent = onEvent;

        // Isolate browser session per chat session (thread-safe — no global mutable)
        activeBrowserSessionId = sessionId;

        // ── Best-friend memory injection ──
        // Load user profile + auto-search relevant memories
        // These get injected into the system prompt so the agent
        // STARTS the conversation already knowing who you are.
        const [contextBlock, relevantMemories] = await Promise.all([
          buildContextBlock(memoryIndex),
          autoSearchContext(memoryIndex, message),
        ]);

        // Initialize threat engine for this session
        const threatEngine = new ThreatEngine(dataDir, sessionId);

        // Inject canary tokens into system prompt (prompt injection detection)
        const enrichedPrompt =
          config.systemPrompt + contextBlock + relevantMemories + threatEngine.getCanaryBlock();

        const result = await runAgent(message, session.messages, {
          apiKey,
          model: provider === "codex" ? "gpt-5.3-codex" : config.model,
          provider,
          systemPrompt: enrichedPrompt,
          tools,
          security,
          toolPolicy,
          threatEngine,
          sessionId,
          maxIterations: config.maxIterations,
          temperature: config.temperature,
          onEvent: (event) => {
            // Canary check on streamed text — if canary leaks, LLM is compromised
            if (event.type === "stream" && event.delta) {
              const canaryTrip = threatEngine.checkOutput(event.delta);
              if (canaryTrip) {
                sseWrite(res, { type: "error", message: "Security alert: prompt injection detected. Response terminated." });
                return; // Don't forward the compromised text
              }
            }
            onEvent(event);
          },
        });

        activeOnEvent = undefined;

        // Update session (skip system prompt + empty messages)
        session.messages = result.messages.filter(
          (m) => m.role !== "system" && (m.content || (m as any).tool_calls)
        );
        session.updatedAt = Date.now();

        // Auto-extract profile facts from this exchange
        // (safety net — persists name changes etc. even if LLM forgets to call tools)
        const assistantReply = result.messages
          .filter((m) => m.role === "assistant" && typeof m.content === "string")
          .map((m) => m.content as string)
          .join("\n");
        try {
          autoExtractAndSave(memoryIndex, message, assistantReply);
        } catch (e) {
          console.warn("[memory] Auto-extract failed:", (e as Error).message);
        }

        // Persist to disk
        saveSession(session);
      } catch (e) {
        sseWrite(res, { type: "error", message: (e as Error).message });
        // Always send done so browser clears spinner
        sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
      }

      res.end();
      return;
    }

    // OAuth login trigger
    if (method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const { startOAuthLogin } = await import("./auth.js");
        await startOAuthLogin();
        json(200, { ok: true });
      } catch (e) {
        json(500, { error: (e as Error).message });
      }
      return;
    }

    // Auth status
    if (method === "GET" && url.pathname === "/api/auth/status") {
      const { loadTokens } = await import("./auth.js");
      const tokens = loadTokens();
      json(200, {
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
    json(404, { error: "Not found" });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`\n  Secret Agent X running at http://127.0.0.1:${config.port}`);
    console.log(`  Auth token: ${config.authToken.slice(0, 8)}...`);
    console.log(`  Memory: ${dataDir}/memory/`);
    console.log(`  Sessions: ${dataDir}/sessions/\n`);
  });

  // Cleanup on exit
  process.on("SIGINT", async () => {
    await closeAllBrowsers();
    memoryIndex.close();
    process.exit(0);
  });

  return server;
}
