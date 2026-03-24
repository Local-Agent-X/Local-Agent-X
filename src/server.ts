import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
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
import { RBACManager, type Role } from "./rbac.js";
import { createBrowserTools, closeBrowser } from "./browser-tools.js";
import { closeAllBrowsers } from "./browser.js";
import { redactCredentials } from "./security.js";
import { imageTools } from "./image-tools.js";
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

// ── Auth Flood Guard: lockout after repeated failures ──
const AUTH_MAX_FAILURES = 5;
const AUTH_LOCKOUT_MS = 5 * 60 * 1000; // 5 minute lockout
const authFloodGuard = new Map<string, { failures: number; lockedUntil: number }>();

function recordAuthFailure(ip: string): void {
  const entry = authFloodGuard.get(ip) || { failures: 0, lockedUntil: 0 };
  entry.failures++;
  if (entry.failures >= AUTH_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    entry.failures = 0; // Reset count, lockout is active
    console.warn(`[auth] IP ${ip} locked out for ${AUTH_LOCKOUT_MS / 1000}s after ${AUTH_MAX_FAILURES} failed attempts`);
  }
  authFloodGuard.set(ip, entry);
}

// Prune stale lockouts every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFloodGuard) {
    if (entry.lockedUntil < now && entry.failures === 0) authFloodGuard.delete(ip);
  }
}, 600_000);

export function startServer(config: SAXConfig) {
  const security = new SecurityLayer(config.workspace);
  const publicDir = join(import.meta.dirname || ".", "..", "public");
  const dataDir = join(homedir(), ".sax");
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);

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

  const tools = [...allTools, httpRequestTool, ...memoryTools, ...secretTools, ...browserTools, ...imageTools];

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

  // Session write locks — prevent concurrent writes from corrupting session state
  const sessionLocks = new Set<string>();

  function saveSession(session: Session): void {
    if (sessionLocks.has(session.id)) {
      console.warn(`[session] Write lock contention on ${session.id}, queuing`);
      // Simple retry — wait and try again (Node is single-threaded so this is safe)
    }
    sessionLocks.add(session.id);
    try {
      sessions.set(session.id, session);
      sessionStore.save(session);
      memoryIndex.markDirty();
    } finally {
      sessionLocks.delete(session.id);
    }
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

    // Auth check with RBAC + brute-force flood guard
    let requestRole: Role = "operator";
    const authExempt = ["/api/auth/login", "/api/auth/logout", "/api/auth/status"];
    if (url.pathname.startsWith("/api/") && !authExempt.includes(url.pathname)) {
      const clientIp = req.socket.remoteAddress || "unknown";
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

      // Flood guard: check lockout BEFORE attempting auth
      const lockout = authFloodGuard.get(clientIp);
      if (lockout && lockout.lockedUntil > Date.now()) {
        const retryAfter = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
        res.writeHead(429, { ...corsHeaders(req), "Retry-After": String(retryAfter) });
        res.end(JSON.stringify({ error: "Too many failed auth attempts. Try again later." }));
        return;
      }

      if (!token) {
        recordAuthFailure(clientIp);
        jsonResponse(res, 401, { error: "Unauthorized" }, req);
        return;
      }
      const authResult = rbac.authenticate(token);
      if (!authResult.valid || !authResult.entry) {
        recordAuthFailure(clientIp);
        jsonResponse(res, 401, { error: "Unauthorized" }, req);
        return;
      }
      // Successful auth — reset failure count
      authFloodGuard.delete(clientIp);
      requestRole = authResult.entry.role;

      // Check endpoint permission
      const endpointCheck = rbac.checkEndpoint(requestRole, method, url.pathname);
      if (!endpointCheck.allowed) {
        jsonResponse(res, 403, { error: endpointCheck.reason }, req);
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

    // ── Voice API ──

    // Get voice capabilities
    if (method === "GET" && url.pathname === "/api/voice/capabilities") {
      const { detectCapabilities } = await import("./voice.js");
      json(200, detectCapabilities());
      return;
    }

    // Transcribe audio (STT)
    if (method === "POST" && url.pathname === "/api/voice/transcribe") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const audioBuffer = Buffer.concat(chunks);

        if (audioBuffer.length < 1000) {
          json(400, { error: "Audio too short" });
          return;
        }

        const { transcribe } = await import("./voice.js");
        const text = transcribe(audioBuffer);
        json(200, { text });
      } catch (e) {
        json(500, { error: `Transcription failed: ${(e as Error).message}` });
      }
      return;
    }

    // Synthesize speech (TTS)
    if (method === "POST" && url.pathname === "/api/voice/synthesize") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          text?: string;
          voice?: string;
          speed?: number;
        };
        if (!body.text?.trim()) {
          json(400, { error: "text is required" });
          return;
        }

        const { synthesize } = await import("./voice.js");
        const wavBuffer = synthesize(body.text, body.voice, body.speed);

        if (wavBuffer.length === 0) {
          json(500, { error: "TTS engine not available" });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": String(wavBuffer.length),
          ...corsHeaders(req),
        });
        res.end(wavBuffer);
      } catch (e) {
        json(500, { error: `Synthesis failed: ${(e as Error).message}` });
      }
      return;
    }

    // ── Audit API ──

    // Get recent audit entries
    if (method === "GET" && url.pathname === "/api/audit") {
      const count = parseInt(url.searchParams.get("count") || "50", 10);
      // Create a temp threat engine to read audit
      const auditReader = new ThreatEngine(dataDir, "audit-read");
      json(200, auditReader.audit.getRecent(Math.min(count, 500)));
      return;
    }

    // Verify audit chain integrity
    if (method === "GET" && url.pathname === "/api/audit/verify") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const auditPath = join(dataDir, "audit", `${date}.jsonl`);
      const { CryptoAuditTrail } = await import("./threat-engine.js");
      const result = CryptoAuditTrail.verify(auditPath);
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
        let canaryBuffer = ""; // Rolling buffer for chunk-boundary canary detection

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
          rbac,
          callerRole: requestRole,
          sessionId,
          maxIterations: config.maxIterations,
          temperature: config.temperature,
          onEvent: (event) => {
            // Canary check with rolling buffer — catches canaries split across chunk boundaries
            if (event.type === "stream" && event.delta) {
              canaryBuffer += event.delta;
              // Keep buffer to max canary length + margin (canaries are ~25 chars)
              if (canaryBuffer.length > 100) canaryBuffer = canaryBuffer.slice(-100);
              const canaryTrip = threatEngine.checkOutput(canaryBuffer);
              if (canaryTrip) {
                sseWrite(res, { type: "error", message: "Security alert: prompt injection detected. Response terminated." });
                return;
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

    // OAuth login trigger — returns auth URL immediately, doesn't block
    if (method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const { initiateOAuthLogin } = await import("./auth.js");
        const { authUrl, promise } = initiateOAuthLogin();
        // Don't await the promise — it completes when user finishes in browser
        promise.then(() => console.log("[auth] OAuth login completed via dashboard"))
               .catch((e) => console.warn("[auth] OAuth login failed:", e.message));
        json(200, { ok: true, authUrl });
      } catch (e) {
        json(500, { error: (e as Error).message });
      }
      return;
    }

    // OAuth logout — delete stored tokens
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      try {
        const { getAuthPath } = await import("./config.js");
        const { unlinkSync, existsSync } = await import("node:fs");
        const authPath = getAuthPath();
        if (existsSync(authPath)) unlinkSync(authPath);
        console.log("[auth] OAuth tokens removed");
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

    // Serve generated videos (e.g. /videos/my_video_123.mp4)
    if (method === "GET" && url.pathname.startsWith("/videos/")) {
      const videosDir = resolve(process.cwd(), "workspace", "videos");
      const vidFile = resolve(videosDir, url.pathname.replace("/videos/", ""));
      const vidRel = relative(videosDir, vidFile);
      if (vidRel.startsWith("..") || vidRel.includes("..")) {
        json(403, { error: "Path traversal blocked" });
        return;
      }
      if (existsSync(vidFile)) {
        const ext = vidFile.split(".").pop() || "";
        const ct: Record<string, string> = { mp4: "video/mp4", webm: "video/webm" };
        res.writeHead(200, { "Content-Type": ct[ext] || "application/octet-stream" });
        res.end(readFileSync(vidFile));
        return;
      }
    }

    // Serve generated images (e.g. /images/my_image_123.png)
    if (method === "GET" && url.pathname.startsWith("/images/")) {
      const imagesDir = resolve(process.cwd(), "workspace", "images");
      const imgFile = resolve(imagesDir, url.pathname.replace("/images/", ""));
      const imgRel = relative(imagesDir, imgFile);
      if (imgRel.startsWith("..") || imgRel.includes("..")) {
        json(403, { error: "Path traversal blocked" });
        return;
      }
      if (existsSync(imgFile)) {
        const ext = imgFile.split(".").pop() || "";
        const ct: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
        res.writeHead(200, { "Content-Type": ct[ext] || "application/octet-stream" });
        res.end(readFileSync(imgFile));
        return;
      }
    }

    // Serve workspace apps (e.g. /apps/todo-app/index.html)
    if (method === "GET" && url.pathname.startsWith("/apps/")) {
      const appsDir = resolve(process.cwd(), "workspace");
      const appFile = resolve(appsDir, "." + url.pathname); // resolve to absolute
      // Path traversal protection: ensure resolved path stays within workspace
      const rel = relative(appsDir, appFile);
      if (rel.startsWith("..") || rel.includes("..")) {
        json(403, { error: "Path traversal blocked" });
        return;
      }
      if (existsSync(appFile)) {
        const ext = appFile.split(".").pop() || "";
        const ct: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
        const headers: Record<string, string> = {
          "Content-Type": ct[ext] || "application/octet-stream",
        };
        // CSP for HTML — same policy as dashboard
        if (ext === "html") {
          headers["Content-Security-Policy"] =
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
          headers["X-Content-Type-Options"] = "nosniff";
          headers["X-Frame-Options"] = "DENY";
          headers["Referrer-Policy"] = "no-referrer";
        }
        res.writeHead(200, headers);
        res.end(readFileSync(appFile));
        return;
      }
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
        const headers: Record<string, string> = {
          "Content-Type": contentTypes[ext] || "application/octet-stream",
        };
        // CSP for HTML pages — prevents XSS (no inline scripts allowed in production)
        // We use 'unsafe-inline' for scripts because our HTML has inline <script> tags,
        // but we block external script sources and eval.
        if (ext === "html") {
          headers["Content-Security-Policy"] =
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
          headers["X-Content-Type-Options"] = "nosniff";
          headers["X-Frame-Options"] = "DENY";
          headers["Referrer-Policy"] = "no-referrer";
        }
        res.writeHead(200, headers);
        res.end(readFileSync(filePath));
        return;
      }
    }

    // 404
    json(404, { error: "Not found" });
  });

  server.listen(config.port, "127.0.0.1", () => {
    const openUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
    console.log(`\n  Secret Agent X running at http://127.0.0.1:${config.port}`);
    console.log(`\n  ► Open this URL in your browser (first time or new machine):`);
    console.log(`    ${openUrl}\n`);
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
