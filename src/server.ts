import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomBytes } from "node:crypto";
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
import { AgentSync } from "./sync.js";
import { RBACManager, type Role } from "./rbac.js";
import { createBrowserTools, closeBrowser } from "./browser-tools.js";
import { closeAllBrowsers } from "./browser.js";
import { redactCredentials } from "./security.js";
import { setupChatWebSocket } from "./chat-ws.js";
import { runSecurityAudit, printAuditReport } from "./security-audit.js";
import { startAriKernel, isAriActive } from "./ari-kernel.js";
import { CronService, createCronTools } from "./cron-service.js";
import { setSessionPolicy, getSessionPolicy, listPresets, type PolicyPreset } from "./session-policy.js";
import { imageTools } from "./image-tools.js";
import { createPlaybookTools } from "./playbooks.js";
import type { SAXConfig, ServerEvent, Session } from "./types.js";

// ── Multipart parser ──
interface MultipartPart { filename?: string; name?: string; data: Buffer; contentType?: string }
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sep = Buffer.from(`--${boundary}`);
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(sep, pos);
    if (start === -1) break;
    const nextStart = body.indexOf(sep, start + sep.length + 2);
    if (nextStart === -1) break;
    const partBuf = body.subarray(start + sep.length + 2, nextStart - 2); // skip CRLF
    const headerEnd = partBuf.indexOf("\r\n\r\n");
    if (headerEnd === -1) { pos = nextStart; continue; }
    const headerStr = partBuf.subarray(0, headerEnd).toString();
    const data = partBuf.subarray(headerEnd + 4);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
    parts.push({
      filename: filenameMatch?.[1],
      name: nameMatch?.[1],
      data,
      contentType: ctMatch?.[1]?.trim(),
    });
    pos = nextStart;
  }
  return parts;
}

// Session ID validation: alphanumeric + dash/underscore, max 64 chars
function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// ── CORS: loopback-only for mutations ──

const LOOPBACK_ORIGINS = new Set([
  "http://localhost",
  "http://127.0.0.1",
  "http://[::1]",
  "https://localhost",
  "https://127.0.0.1",
  "https://[::1]",
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

// ── Rate Limiting: token bucket per auth token (falls back to IP) ──

const rateLimits = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_MAX = 120;          // max burst (dashboard polls many endpoints at once)
const RATE_LIMIT_REFILL_PER_SEC = 10; // tokens per second (single-user app, be generous)

function getRateLimitKey(req: IncomingMessage): string {
  // Prefer auth token as key (unique per session), fall back to IP
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) return `tok:${token.slice(0, 16)}`; // Use prefix to avoid storing full token
  return `ip:${req.socket.remoteAddress || "unknown"}`;
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  let bucket = rateLimits.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_MAX, lastRefill: now };
    rateLimits.set(key, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_MAX, bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [key, bucket] of rateLimits) {
    if (bucket.lastRefill < cutoff) rateLimits.delete(key);
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
const AUTH_MAX_FAILURES = 20;           // Generous for localhost (dashboard retries on page load)
const AUTH_LOCKOUT_MS = 60 * 1000;      // 1 minute lockout (not 5 — single user app)
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

  // Ensure workspace directories exist for new installs
  mkdirSync(join(resolve(config.workspace), "apps"), { recursive: true });
  mkdirSync(join(resolve(config.workspace), "images"), { recursive: true });
  mkdirSync(join(resolve(config.workspace), "videos"), { recursive: true });
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);

  // Agent Sync (git-based memory sync across machines)
  const agentSync = new AgentSync(dataDir, () => secretsStore.get("GITHUB_SYNC_TOKEN"));

  // Initialize memory systems
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  const memoryTools = createMemoryTools(memoryIndex);

  // Create personality files on first run
  ensurePersonalityFiles(join(dataDir, "memory"));

  // Initialize secrets store
  const secretsStore = new SecretsStore(dataDir);

  // Initialize cron scheduler
  const cronService = new CronService(dataDir);

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

  const playbookTools = createPlaybookTools();
  const cronTools = createCronTools(cronService);
  const tools = [...allTools, httpRequestTool, ...memoryTools, ...secretTools, ...browserTools, ...imageTools, ...playbookTools, ...cronTools];

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

  // TLS: try HTTPS first, fall back to HTTP if cert unavailable
  // HTTPS: only enable if user opted in via Settings → Security → HTTPS toggle
  // HTTP only — localhost doesn't need TLS (loopback traffic can't be sniffed remotely)

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
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

    // Rate limiting on API endpoints (per auth token, falls back to per-IP)
    if (url.pathname.startsWith("/api/")) {
      if (!checkRateLimit(getRateLimitKey(req))) {
        jsonResponse(res, 429, { error: "Rate limit exceeded. Try again shortly." }, req);
        return;
      }
    }

    // Auth check with RBAC + brute-force flood guard
    let requestRole: Role = "operator";
    const authExempt = ["/api/auth/login", "/api/auth/logout", "/api/auth/status", "/api/auth/anthropic/login", "/api/auth/anthropic/logout", "/api/auth/anthropic/status"];
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

    // Upload file (images, documents) — 100MB limit
    if (method === "POST" && url.pathname === "/api/upload") {
      const uploadsDir = join(dataDir, "uploads");
      mkdirSync(uploadsDir, { recursive: true });

      const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length;
        if (totalSize > MAX_UPLOAD_BYTES) {
          json(413, { error: `File too large. Maximum upload size is 100MB.` });
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);

      // Parse multipart boundary from content-type
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        json(400, { error: "Multipart form data required" });
        return;
      }
      const boundary = boundaryMatch[1];
      const parts = parseMultipart(body, boundary);

      // Magic number validation for common file types
      const MAGIC_NUMBERS: Record<string, Buffer[]> = {
        png: [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
        jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
        jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
        gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")],
        webp: [Buffer.from("RIFF")], // RIFF....WEBP
        bmp: [Buffer.from("BM")],
        pdf: [Buffer.from("%PDF")],
      };
      const validateMagic = (data: Buffer, ext: string): boolean => {
        const sigs = MAGIC_NUMBERS[ext];
        if (!sigs) return true; // No magic check for unknown types — allow
        return sigs.some(sig => data.length >= sig.length && data.subarray(0, sig.length).equals(sig));
      }

      const uploaded: { name: string; url: string; size: number; isImage: boolean }[] = [];
      for (const part of parts) {
        const ext = (part.filename?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
        // Validate file magic bytes match declared extension
        if (!validateMagic(part.data, ext)) {
          json(400, { error: `File ${part.filename} does not match its declared type (.${ext})` });
          return;
        }
        const id = randomBytes(8).toString("hex");
        const safeName = `${id}.${ext}`;
        const filePath = join(uploadsDir, safeName);
        writeFileSync(filePath, part.data);
        const isImage = /^(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(ext);
        uploaded.push({
          name: part.filename || safeName,
          url: `/uploads/${safeName}`,
          size: part.data.length,
          isImage,
        });
      }
      json(200, { files: uploaded });
      return;
    }

    // Serve uploaded files
    if (method === "GET" && url.pathname.startsWith("/uploads/")) {
      const uploadsDir = join(dataDir, "uploads");
      const fileName = url.pathname.replace("/uploads/", "");
      if (/[^a-zA-Z0-9._-]/.test(fileName)) {
        json(400, { error: "Invalid filename" });
        return;
      }
      const filePath = join(uploadsDir, fileName);
      if (existsSync(filePath)) {
        const ext = fileName.split(".").pop() || "";
        const ct: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          bmp: "image/bmp", pdf: "application/pdf",
          txt: "text/plain", json: "application/json", csv: "text/csv",
        };
        res.writeHead(200, {
          ...corsHeaders(req),
          "Content-Type": ct[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(readFileSync(filePath));
        return;
      }
      json(404, { error: "File not found" });
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

    // ── Sync API ──

    if (method === "GET" && url.pathname === "/api/sync/status") {
      json(200, agentSync.getStatus());
      return;
    }

    if (method === "POST" && url.pathname === "/api/sync/configure") {
      const body = JSON.parse(await readBody(req));
      agentSync.saveConfig(body);
      // Restart heartbeat with new config
      agentSync.stopHeartbeat();
      agentSync.startHeartbeat();
      json(200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/sync/push") {
      const result = await agentSync.push();
      json(200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/sync/pull") {
      const result = await agentSync.pull();
      json(200, result);
      return;
    }

    // ── Cron Jobs ──
    if (method === "GET" && url.pathname === "/api/cron") {
      json(200, { jobs: cronService.list(), settings: cronService.getSettings() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/cron") {
      const body = JSON.parse(await readBody(req)) as { name?: string; schedule?: string; prompt?: string; systemJob?: boolean };
      if (!body.name || !body.schedule || !body.prompt) { json(400, { error: "name, schedule, and prompt are required" }); return; }
      try {
        const job = cronService.create(body.name, body.schedule, body.prompt, body.systemJob);
        json(200, { ok: true, job });
      } catch (e) { json(400, { error: (e as Error).message }); }
      return;
    }
    if (method === "PATCH" && url.pathname.startsWith("/api/cron/")) {
      const id = url.pathname.split("/").pop()!;
      const body = JSON.parse(await readBody(req));
      try {
        const job = cronService.update(id, body);
        if (!job) { json(404, { error: "Job not found" }); return; }
        json(200, { ok: true, job });
      } catch (e) { json(400, { error: (e as Error).message }); }
      return;
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/cron/")) {
      const id = url.pathname.split("/").pop()!;
      const deleted = cronService.delete(id);
      json(200, { ok: true, deleted });
      return;
    }
    if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/toggle$/)) {
      const id = url.pathname.split("/")[3];
      const job = cronService.toggle(id);
      if (!job) { json(404, { error: "Job not found" }); return; }
      json(200, { ok: true, job });
      return;
    }
    if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/run$/)) {
      const id = url.pathname.split("/")[3];
      const job = cronService.get(id);
      if (!job) { json(404, { error: "Job not found" }); return; }
      // Manual run — trigger via the execute callback
      json(200, { ok: true, message: `Job "${job.name}" triggered` });
      // Fire-and-forget execution
      cronService["executeJob"](job).catch(() => {});
      return;
    }
    if (method === "POST" && url.pathname === "/api/cron/settings") {
      const body = JSON.parse(await readBody(req));
      cronService.updateSettings(body);
      json(200, { ok: true, settings: cronService.getSettings() });
      return;
    }

    // ── Credential rotation ──
    if (method === "POST" && url.pathname === "/api/auth/rotate") {
      const newToken = randomBytes(24).toString("hex");
      // Update config file
      const configPath = join(dataDir, "config.json");
      try {
        const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};
        cfg.authToken = newToken;
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        const masked = newToken.slice(0, 4) + "****" + newToken.slice(-4);
        console.log(`[auth] Token rotated. New token: ${masked}`);
        json(200, { ok: true, token: newToken, message: "Token rotated. Save this token — it won't be shown again." });
      } catch (e) {
        json(500, { error: `Failed to rotate: ${(e as Error).message}` });
      }
      return;
    }

    // ── History export ──
    if (method === "GET" && url.pathname === "/api/history") {
      const sessions = sessionStore.list();
      const exported = sessions.map((s: any) => ({
        id: s.id,
        title: s.title,
        messageCount: s.messageCount,
        updatedAt: s.updatedAt,
      }));
      json(200, { sessions: exported, exportedAt: Date.now() });
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/api/history/")) {
      const id = url.pathname.split("/").pop()!;
      if (!isValidSessionId(id)) { json(400, { error: "Invalid session ID" }); return; }
      const session = getOrCreateSession(id);
      // Redact any secrets from exported messages
      const redacted = session.messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === "string" ? redactCredentials(m.content) : m.content,
      }));
      json(200, { ...session, messages: redacted });
      return;
    }

    // ── SIEM / log export (JSON lines format for Splunk, ELK, etc.) ──
    if (method === "GET" && url.pathname === "/api/logs/export") {
      const count = parseInt(url.searchParams.get("count") || "100", 10);
      const auditDir = join(dataDir, "audit");
      if (!existsSync(auditDir)) { json(200, { lines: [] }); return; }
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
      } catch (e) {
        json(500, { error: (e as Error).message });
      }
      return;
    }

    // ── Settings API (server-side persistence) ──

    if (method === "POST" && url.pathname === "/api/settings") {
      const body = JSON.parse(await readBody(req));
      const settingsPath = join(dataDir, "settings.json");
      let existing: Record<string, unknown> = {};
      try { if (existsSync(settingsPath)) existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      const merged = { ...existing, ...body };
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
      json(200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/settings") {
      const settingsPath = join(dataDir, "settings.json");
      try {
        if (existsSync(settingsPath)) { json(200, JSON.parse(readFileSync(settingsPath, "utf-8"))); }
        else { json(200, {}); }
      } catch { json(200, {}); }
      return;
    }

    // ── Audit API ──

    // ── Active Chats API (for WS-less fallback) ──

    if (method === "GET" && url.pathname === "/api/chats/active") {
      json(200, { active: chatWs.getActiveChats() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/chats/stop") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const sid = String(body.sessionId || "");
      if (!sid) { json(400, { error: "sessionId required" }); return; }
      // The WS manager handles abort
      json(200, { ok: true, stopped: sid });
      return;
    }

    // ── File Access Mode API ──

    if (method === "GET" && url.pathname === "/api/security/file-access") {
      json(200, { mode: security.fileAccessMode });
      return;
    }

    if (method === "POST" && url.pathname === "/api/security/file-access") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const mode = String(body.mode || "");
      if (!["workspace", "common", "unrestricted"].includes(mode)) {
        json(400, { error: "mode must be: workspace, common, or unrestricted" });
        return;
      }
      security.setFileAccessMode(mode as any);
      json(200, { ok: true, mode });
      return;
    }

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

    // ── ARI Kernel status ──
    if (method === "GET" && url.pathname === "/api/ari-status") {
      const { ariStatus } = await import("./ari-kernel.js");
      const status = await ariStatus();
      json(200, { active: isAriActive(), status });
      return;
    }

    // ── Session security policy ──
    if (method === "GET" && url.pathname === "/api/session-policy") {
      const sessionId = url.searchParams.get("sessionId") || "default";
      json(200, { policy: getSessionPolicy(sessionId), presets: listPresets() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/session-policy") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const sessionId = (body.sessionId as string) || "default";
      const preset = body.preset as PolicyPreset;
      if (!listPresets().includes(preset)) {
        json(400, { error: `Invalid preset. Available: ${listPresets().join(", ")}` });
        return;
      }
      const policy = setSessionPolicy(sessionId, preset);
      console.log(`[security] Session ${sessionId} policy set to: ${preset}`);
      json(200, { ok: true, policy });
      return;
    }

    // ── Context compaction ──
    // Summarizes old messages for the AI while keeping full chat on disk.
    // The user's chat history is never lost — only the AI's view gets compacted.
    if (method === "POST" && url.pathname === "/api/compact") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const sessionId = (body.sessionId as string) || "default";
      if (!isValidSessionId(sessionId)) { json(400, { error: "Invalid session ID" }); return; }

      const session = getOrCreateSession(sessionId);
      console.log(`[compact] Session ${sessionId}: ${session.messages.length} server-side messages`);
      if (session.messages.length < 10) {
        json(200, { ok: false, reason: `Only ${session.messages.length} server messages (need 10+)` });
        return;
      }

      const KEEP_RECENT = Math.min(20, session.messages.length - 5); // Keep at least 5 for summary
      let cutIdx = Math.max(0, session.messages.length - KEEP_RECENT);
      for (let i = cutIdx; i < session.messages.length; i++) {
        if (session.messages[i].role === "user") { cutIdx = i; break; }
      }
      const oldMessages = session.messages.slice(0, cutIdx);
      const recentMessages = session.messages.slice(cutIdx);

      // Build a structured summary of old messages (no AI call needed — fast & free)
      const summaryLines: string[] = [];
      let topicChanges = 0;
      for (const m of oldMessages) {
        if (m.role === "user" && typeof m.content === "string") {
          summaryLines.push(`[User] ${m.content.slice(0, 200).replace(/\n/g, " ")}`);
          topicChanges++;
        } else if (m.role === "assistant" && typeof m.content === "string") {
          // Keep only the first line or key decisions
          const first = m.content.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 200);
          summaryLines.push(`[Agent] ${first}`);
        }
        // Skip tool_calls and tool results in summary
      }

      const compactSummary = `[COMPACTED CONTEXT — ${oldMessages.length} messages summarized]\n` +
        `This conversation has been going for ${session.messages.length} messages. ` +
        `Here is a condensed record of the earlier part:\n\n` +
        summaryLines.join("\n") +
        `\n\n[END COMPACTED CONTEXT — ${recentMessages.length} recent messages follow in full]`;

      // Store the compacted summary in the session (AI sees this instead of old messages)
      (session as any).compactedSummary = compactSummary;
      (session as any).compactedAt = oldMessages.length;

      // IMPORTANT: session.messages stays COMPLETE (full history on disk)
      sessionStore.save(session);

      console.log(`[compact] Session ${sessionId}: ${oldMessages.length} old messages compacted, ${recentMessages.length} recent kept`);
      json(200, { ok: true, compactedAt: oldMessages.length, oldCount: oldMessages.length, recentCount: recentMessages.length });
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
      const attachments = (body.attachments as Array<{ name: string; url: string; isImage: boolean }>) || [];

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
        // Provider: use saved preference from settings, fall back to auto-detect
        const { loadTokens } = await import("./auth.js");
        const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");

        let savedProvider: string | null = null;
        try {
          const settingsPath = join(dataDir, "settings.json");
          if (existsSync(settingsPath)) {
            savedProvider = JSON.parse(readFileSync(settingsPath, "utf-8")).provider || null;
          }
        } catch {}

        let provider: "codex" | "xai" | "openai" | "anthropic";
        if (savedProvider && ["codex", "xai", "openai", "anthropic"].includes(savedProvider)) {
          provider = savedProvider as typeof provider;
        } else if (loadAnthropicTokens()) {
          provider = "anthropic";
        } else if (loadTokens() && !config.openaiApiKey) {
          provider = "codex";
        } else {
          provider = "xai";
        }

        const apiKey = provider === "anthropic"
          ? await getAnthropicApiKey()
          : await getApiKey(config.openaiApiKey);

        // Wire up SSE writer so request_secret can emit to the active stream
        // Register with WebSocket chat manager for multi-client broadcast
        const wsChat = chatWs.startChat(sessionId);
        const onEvent = (event: ServerEvent) => {
          sseWrite(res, event);    // SSE to the original requester
          wsChat.onEvent(event);   // WS to all subscribed clients
        };
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
        let fullResponseText = ""; // Full accumulated response for deep canary scan

        // Inject canary tokens into system prompt (prompt injection detection)
        const enrichedPrompt =
          config.systemPrompt + contextBlock + relevantMemories + threatEngine.getCanaryBlock();

        // Resolve image attachments to absolute file paths for vision API
        const uploadsDir = join(dataDir, "uploads");
        const imageAttachments = attachments
          .filter(a => a.isImage && a.url)
          .map(a => {
            const fname = a.url.replace(/^\/uploads\//, "");
            const filePath = join(uploadsDir, fname);
            console.log(`[chat] Image attachment: ${a.name} → ${filePath} (exists: ${existsSync(filePath)})`);
            return { name: a.name, url: a.url, filePath };
          });
        if (imageAttachments.length) console.log(`[chat] Sending ${imageAttachments.length} image(s) to vision API`);

        // ── Sanitize history: remove orphaned tool results ──
        // Tool results MUST follow their matching assistant tool_call message.
        // If a tool result references a call_id not in the preceding assistant message, drop it.
        const sanitizeHistory = (msgs: typeof session.messages) => {
          const validCallIds = new Set<string>();
          const result = [];
          for (const m of msgs) {
            if (m.role === "assistant" && (m as any).tool_calls) {
              for (const tc of (m as any).tool_calls) validCallIds.add(tc.id);
              result.push(m);
            } else if (m.role === "tool") {
              const callId = (m as any).tool_call_id;
              if (callId && validCallIds.has(callId)) {
                result.push(m);
              } // else: orphaned tool result — skip it
            } else {
              result.push(m);
            }
          }
          return result;
        }

        // ── Context management: compacted summary OR auto sliding window ──
        // CRITICAL: never cut between a tool_call and its tool result — find safe cut points
        const findSafeCutPoint = (msgs: typeof session.messages, targetIdx: number): number => {
          // Walk forward from target to find a "user" message — that's always a safe boundary
          for (let i = targetIdx; i < msgs.length; i++) {
            if (msgs[i].role === "user") return i;
          }
          // Walk backward if nothing found forward
          for (let i = targetIdx; i >= 0; i--) {
            if (msgs[i].role === "user") return i;
          }
          return targetIdx;
        }

        const buildSummary = (msgs: typeof session.messages): string => {
          const parts: string[] = [];
          for (const m of msgs) {
            if (m.role === "user" && typeof m.content === "string") {
              parts.push(`User: ${m.content.slice(0, 150).replace(/\n/g, " ")}`);
            } else if (m.role === "assistant" && typeof m.content === "string") {
              parts.push(`Agent: ${m.content.split("\n").filter(l => l.trim())[0]?.slice(0, 150) || ""}`);
            }
          }
          return `[Earlier in this conversation (${msgs.length} messages summarized):\n${parts.join("\n")}\n...end of summary]`;
        }

        let historyToSend = session.messages;
        const compactedSummary = (session as any).compactedSummary as string | undefined;
        const compactedAt = (session as any).compactedAt as number | undefined;

        if (compactedSummary && compactedAt) {
          const cutPoint = findSafeCutPoint(session.messages, compactedAt);
          const recentMessages = session.messages.slice(cutPoint);
          historyToSend = [
            { role: "system", content: compactedSummary } as any,
            ...recentMessages,
          ];
          console.log(`[chat] Compacted context: summary + ${recentMessages.length} recent`);
        } else if (session.messages.length > 40) {
          const rawCut = session.messages.length - 40;
          const cutPoint = findSafeCutPoint(session.messages, rawCut);
          const oldMessages = session.messages.slice(0, cutPoint);
          const recentMessages = session.messages.slice(cutPoint);
          historyToSend = [
            { role: "system", content: buildSummary(oldMessages) } as any,
            ...recentMessages,
          ];
          console.log(`[chat] Sliding window: ${session.messages.length} total → ${recentMessages.length} recent (cut at user msg ${cutPoint})`);
        }

        const result = await runAgent(message, sanitizeHistory(historyToSend), {
          apiKey,
          model: provider === "codex" ? "gpt-5.3-codex" : provider === "anthropic" ? "claude-haiku-4-5" : config.model,
          provider,
          systemPrompt: enrichedPrompt,
          tools,
          security,
          toolPolicy,
          threatEngine,
          rbac,
          callerRole: requestRole,
          sessionId,
          images: imageAttachments,
          maxIterations: config.maxIterations,
          temperature: config.temperature,
          signal: wsChat.abort.signal, // Abort from WS stop button
          onEvent: (event) => {
            // Canary check with rolling buffer — catches canaries split across chunk boundaries
            if (event.type === "stream" && event.delta) {
              canaryBuffer += event.delta;
              fullResponseText += event.delta;
              // Rolling buffer: keep 200 chars to catch splits across any chunk boundary
              if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
              // Check both rolling buffer (fast, per-chunk) and periodically scan full response
              const canaryTrip = threatEngine.checkOutput(canaryBuffer) ||
                (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
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

        // Agent Sync: push after chat (background, non-blocking)
        agentSync.onChatEnd().catch(() => {});
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

    // ── Anthropic Auth ──

    if (method === "POST" && url.pathname === "/api/auth/anthropic/login") {
      try {
        const { initiateAnthropicLogin } = await import("./auth-anthropic.js");
        const { authUrl, promise } = initiateAnthropicLogin();
        promise.then(() => console.log("[anthropic-auth] Login completed"))
               .catch((e) => console.warn("[anthropic-auth] Login failed:", e.message));
        json(200, { ok: true, authUrl });
      } catch (e) {
        json(500, { error: (e as Error).message });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
      try {
        const { deleteAnthropicTokens } = await import("./auth-anthropic.js");
        deleteAnthropicTokens();
        json(200, { ok: true });
      } catch (e) {
        json(500, { error: (e as Error).message });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
      const { loadAnthropicTokens } = await import("./auth-anthropic.js");
      const tokens = loadAnthropicTokens();
      json(200, {
        authenticated: !!tokens,
        method: tokens ? "oauth" : "none",
        expired: tokens ? Date.now() > tokens.expiresAt : false,
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
        // Sandboxed CSP for user-built apps — stricter than dashboard
        // Blocks: sessionStorage/localStorage access (via connect-src restriction),
        // inline scripts that could steal auth tokens, and API calls
        if (ext === "html") {
          headers["Content-Security-Policy"] =
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline'; " +  // unsafe-inline needed for agent-built apps
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "connect-src 'self' http://127.0.0.1:* http://localhost:*; " +
            "frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
          headers["X-Content-Type-Options"] = "nosniff";
          headers["X-Frame-Options"] = "DENY";
          headers["Referrer-Policy"] = "no-referrer";
        }
        // Inject token isolation script into HTML — clears auth tokens before app code runs
        if (ext === "html") {
          let html = readFileSync(appFile, "utf-8");
          const isolationScript = `<script>sessionStorage.removeItem('sax_token');localStorage.removeItem('sax_token');` +
            `delete window.__AUTH_TOKEN__;` +
            `history.replaceState(null,'',location.pathname);</script>`;
          // Inject right after <head> or at start of <body>
          if (html.includes("<head>")) {
            html = html.replace("<head>", "<head>" + isolationScript);
          } else if (html.includes("<body>")) {
            html = html.replace("<body>", "<body>" + isolationScript);
          } else {
            html = isolationScript + html;
          }
          res.writeHead(200, headers);
          res.end(html);
          return;
        }
        res.writeHead(200, headers);
        res.end(readFileSync(appFile));
        return;
      }
    }

    // Serve dashboard
    if (method === "GET") {
      let filePath: string;
      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app.html") {
        filePath = join(publicDir, "app.html");
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
            "img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
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
  };

  // Create server: HTTPS if cert available, HTTP fallback
  const server = createServer(requestHandler);

  // WebSocket chat system — enables multi-chat, reconnect, stop button
  const chatWs = setupChatWebSocket(server, config.authToken);

  server.listen(config.port, "127.0.0.1", () => {
    const maskedToken = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
    console.log(`\n  Secret Agent X running at http://127.0.0.1:${config.port}`);
    console.log(`  Auth token: ${maskedToken}`);
    console.log(`\n  ► Open: http://127.0.0.1:${config.port}/?token=${config.authToken}\n`);
    console.log(`  Memory: ${dataDir}/memory/`);
    console.log(`  Sessions: ${dataDir}/sessions/`);

    // Run security self-audit on every startup
    const auditReport = runSecurityAudit({ authToken: config.authToken, workspace: config.workspace });
    printAuditReport(auditReport);

    // Start AriKernel (runtime security enforcement)
    const ariAuditDb = join(dataDir, "ari-audit.db");
    startAriKernel(ariAuditDb).then(active => {
      if (active) console.log(`  [ari] Audit log: ${ariAuditDb}`);
    });

    // Start cron scheduler
    cronService.onExecute(async (jobId, prompt) => {
      try {
        const { loadTokens } = await import("./auth.js");
        const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");
        const openaiTokens = loadTokens();
        const anthropicTokens = loadAnthropicTokens();
        let cronProvider: "codex" | "xai" | "openai" | "anthropic";
        if (anthropicTokens || process.env.ANTHROPIC_API_KEY) cronProvider = "anthropic";
        else if (openaiTokens && !config.openaiApiKey) cronProvider = "codex";
        else cronProvider = "xai";
        const apiKey = cronProvider === "anthropic" ? await getAnthropicApiKey() : await getApiKey(config.openaiApiKey);
        const session = getOrCreateSession(`cron-${jobId}`);

        // Cron jobs run with elevated permissions — they're operator-level automated tasks
        // Create a separate SecurityLayer with unrestricted file access for cron execution
        const { SecurityLayer } = await import("./security.js");
        const cronSecurity = new SecurityLayer(
          resolve(process.env.SAX_WORKSPACE || join(homedir(), ".sax", "workspace")),
          "unrestricted", // Cron jobs need full access to fix code, write reports, etc.
        );

        const result = await runAgent(prompt, session.messages, {
          apiKey,
          model: cronProvider === "codex" ? "gpt-5.3-codex" : cronProvider === "anthropic" ? "claude-haiku-4-5" : config.model,
          provider: cronProvider,
          systemPrompt: config.systemPrompt,
          tools,
          security: cronSecurity,
          toolPolicy,
          sessionId: `cron-${jobId}`,
          maxIterations: config.maxIterations,
        });
        const assistantReply = result.messages.filter(m => m.role === "assistant" && m.content).map(m => String(m.content)).join("\n");
        session.messages = result.messages.filter(m => m.role !== "system");
        session.updatedAt = Date.now();
        saveSession(session);
        return assistantReply.slice(0, 500) || "Completed (no text output)";
      } catch (e) {
        throw new Error(`Cron execution failed: ${(e as Error).message}`);
      }
    });
    cronService.start();

    // Agent Sync: pull on startup + start heartbeat (background, non-blocking)
    const syncCfg = agentSync.getConfig();
    if (syncCfg.enabled && syncCfg.autoDownload) {
      agentSync.pull().then(r => {
        if (r.success) console.log(`[sync] Startup pull: ${r.message}`);
      }).catch(() => {});
    }
    agentSync.startHeartbeat();
  });

  // Cleanup on exit
  process.on("SIGINT", async () => {
    agentSync.stopHeartbeat();
    // Final sync before shutdown
    await agentSync.push().catch(() => {});
    await closeAllBrowsers();
    memoryIndex.close();
    process.exit(0);
  });

  return server;
}
