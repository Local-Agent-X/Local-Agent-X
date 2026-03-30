import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
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
import { closeAllBrowsers, setBrowserAuthContext } from "./browser.js";
import { redactCredentials } from "./security.js";
import { setupChatWebSocket, broadcastAll } from "./chat-ws.js";
import { runSecurityAudit, printAuditReport } from "./security-audit.js";
import { startAriKernel, isAriActive } from "./ari-kernel.js";
import { CronService, createCronTools } from "./cron-service.js";
import { setSessionPolicy, getSessionPolicy, listPresets, type PolicyPreset } from "./session-policy.js";
import { imageTools } from "./image-tools.js";
import { createMissionTools } from "./missions.js";
// Background task queue removed — sub-agent system handles background work
import { createAllMissionTools } from "./missions/index.js";
import { runInjectionTests } from "./security-tests.js";
import { getThreatDashboard, recordThreatEvent } from "./threat-dashboard.js";
import { listPolicies, createPolicy, updatePolicy, deletePolicy, evaluateCustomPolicies, exportPolicies } from "./ari-policy-editor.js";
import { checkEgress, listEgressRules, addEgressRule, removeEgressRule } from "./egress-policy.js";
import { scanForSecrets, containsSecrets } from "./secret-scanner.js";
import { recordFileAccess, queryFileAccess, getRecentFileAccess } from "./file-audit.js";
import { getToolRateLimiter } from "./tool-rate-limiter.js";
import { queryAuditLog, getAuditSummary } from "./ari-audit-viewer.js";
import { runBenchmarks } from "./ari-benchmarks.js";
import { createVoiceRouter } from "./voice-commands.js";
import { captureFrame, captureAndDescribe } from "./camera-tool.js";
import { captureScreen } from "./screen-capture.js";
import { extractText } from "./ocr-tool.js";
import { IntegrationRegistry } from "./integrations.js";
import { WhatsAppBridge } from "./whatsapp-bridge.js";
import { TelegramBridge } from "./telegram-bridge.js";
import { recordToolCall as trackTool, getToolStats, getToolSuccessRate, getRecentFailures } from "./tool-tracker.js";
import { withRetry } from "./auto-retry.js";
import { saveCheckpoint, loadCheckpoint, hasCheckpoint } from "./session-recovery.js";
import { categorizeError } from "./error-categories.js";
import { estimateTokens, getContextUsage } from "./context-usage.js";
import { recordCrash, getCrashReport, getTopCrashPatterns } from "./crash-analytics.js";
import { ResponseCache } from "./response-cache.js";
import { exportSession, importSession } from "./session-export.js";
import { loadSessionPage, getSessionMessageCount } from "./progressive-loader.js";
import { runMigrations } from "./db-migrations.js";
import { runStartupTests } from "./startup-test.js";
import { PluginManager } from "./plugin-system.js";
import { createSwarmTools } from "./swarm/index.js";
import { createPrimalTools } from "./swarm/primal.js";
import { EventBus } from "./event-bus.js";
import { generateFullSpec } from "./api-docs.js";
import { ConfigWatcher } from "./config-hot-reload.js";
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

// Strip file paths, stack traces, and internal details from error messages sent to clients
function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Remove absolute file paths (C:\..., /home/..., etc.)
  let safe = raw.replace(/[A-Z]:\\[^\s:'"]+/gi, "[path]").replace(/\/(?:home|usr|tmp|var|Users|root|etc|mnt|opt)\b[^\s:'"]+/gi, "[path]");
  // Remove stack-trace-like lines
  safe = safe.replace(/\s+at\s+.+\(.+\)/g, "");
  // Cap length
  if (safe.length > 200) safe = safe.slice(0, 197) + "...";
  return safe;
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
  const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
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
  let size = 0;
  const MAX_BODY = 10 * 1024 * 1024; // 10MB limit for JSON endpoints
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Safely parse JSON body — returns parsed object or null on invalid JSON */
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

async function safeParseBody(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw, (key, value) => {
      if (BANNED_KEYS.has(key)) return undefined;
      return value;
    });
  } catch {
    return null;
  }
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

  // Pass auth token + port to BrowserManager via setter (not env vars, to avoid leaking to child processes)
  setBrowserAuthContext(config.authToken, String(config.port));

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

  // Initialize image tools with secrets store for API-based image generation
  import("./image-tools.js").then(m => m.initImageTools?.(secretsStore)).catch(() => {});

  // Initialize cron scheduler
  const cronService = new CronService(dataDir);

  // Initialize API integrations registry
  const integrations = new IntegrationRegistry(dataDir);

  // Shared message handler for all bridges (WhatsApp, Telegram, etc.)
  async function bridgeMessageHandler(platform: string, { from, name, text, sessionId }: { from: string; name: string; text: string; sessionId: string }): Promise<string> {
    const { loadTokens } = await import("./auth.js");
    const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");

    let savedProvider: string | null = null;
    let savedModel: string | null = null;
    try {
      const settingsPath = join(dataDir, "settings.json");
      if (existsSync(settingsPath)) {
        const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
        savedProvider = s.provider || null;
        savedModel = s.model || null;
      }
    } catch {}

    let provider: "codex" | "xai" | "openai" | "anthropic" | "local" | "gemini" | "custom";
    if (savedProvider && ["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"].includes(savedProvider)) {
      provider = savedProvider as typeof provider;
    } else if (loadAnthropicTokens()) {
      provider = "anthropic";
    } else if (loadTokens() && !config.openaiApiKey) {
      provider = "codex";
    } else {
      provider = "xai";
    }

    const { getApiKey } = await import("./auth.js");
    let apiKey: string;
    if (provider === "local") {
      apiKey = "ollama";
    } else if (provider === "anthropic") {
      apiKey = await getAnthropicApiKey();
    } else if (provider === "xai") {
      apiKey = secretsStore.get("XAI_API_KEY") || "";
    } else if (provider === "openai" && !config.openaiApiKey) {
      apiKey = secretsStore.get("OPENAI_API_KEY") || await getApiKey(config.openaiApiKey);
    } else {
      apiKey = await getApiKey(config.openaiApiKey);
    }

    const session = getOrCreateSession(sessionId);
    if (session.messages.length === 0) {
      session.title = `${platform}: ${name}`;
    }

    const [contextBlock, relevantMemories] = await Promise.all([
      buildContextBlock(memoryIndex),
      autoSearchContext(memoryIndex, text),
    ]);

    const integrationsContext = integrations.getAgentContext();
    const enrichedPrompt = config.systemPrompt + contextBlock + relevantMemories + integrationsContext +
      `\n\n[${platform} bridge] This message is from ${name} (${from}) via ${platform}. ` +
      `Keep responses concise — ${platform} messages should be shorter than web UI responses. ` +
      `Use plain text (no HTML). Markdown is OK but keep it minimal.`;

    const result = await runAgent(text, session.messages, {
      apiKey,
      model: savedModel || (provider === "codex" ? "gpt-5.3-codex" : provider === "anthropic" ? "claude-sonnet-4-6" : config.model),
      provider,
      systemPrompt: enrichedPrompt,
      tools: primalOnlyTools,
      security,
      toolPolicy,
      sessionId,
      maxIterations: config.maxIterations,
      temperature: config.temperature,
    });

    session.messages = result.messages.filter(
      (m) => m.role !== "system" && (m.content || (m as any).tool_calls)
    );
    session.updatedAt = Date.now();
    saveSession(session);

    return result.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .pop() || "Done.";
  }

  // Initialize WhatsApp bridge
  const whatsappBridge = new WhatsAppBridge({
    dataDir,
    onMessage: (params) => bridgeMessageHandler("WhatsApp", params),
  });

  // Initialize Telegram bridge
  const telegramBridge = new TelegramBridge({
    dataDir,
    getToken: () => secretsStore.get("TELEGRAM_BOT_TOKEN") ?? null,
    onMessage: (params) => bridgeMessageHandler("Telegram", params),
  });

  // Auto-reconnect Telegram if token exists (persists across server restarts)
  if (secretsStore.has("TELEGRAM_BOT_TOKEN")) {
    telegramBridge.connect().then(r => {
      if (r.state === "connected") console.log(`[telegram] Auto-reconnected as @${r.botUsername}`);
      else if (r.state === "error") console.warn("[telegram] Auto-reconnect failed");
    }).catch(() => {});
  }

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

  const missionTools = createMissionTools();
  const extendedMissionTools = createAllMissionTools();
  const cronTools = createCronTools(cronService);
  const rateLimiter = getToolRateLimiter();
  const swarmTools = createSwarmTools();
  const primalTools = createPrimalTools();

  const allAgentTools = [...allTools, httpRequestTool, ...memoryTools, ...secretTools, ...browserTools, ...imageTools, ...missionTools, ...extendedMissionTools, ...cronTools, ...swarmTools, ...primalTools];

  // Primal only gets agent control tools — forces delegation, no direct work
  const PRIMAL_ALLOWED = new Set([
    "agent_spawn", "agent_redirect", "agent_pause", "agent_resume",
    "agent_cancel", "agent_status", "agent_output", "agent_message",
    "delegate", "swarm_create", "swarm_status", "swarm_cancel",
    "swarm_list_roles", "swarm_result", "memory_search", "memory_save",
  ]);
  const primalOnlyTools = allAgentTools.filter(t => PRIMAL_ALLOWED.has(t.name));
  // Full tools for spawned agents (they do the actual work)
  const tools = allAgentTools;

  // In-memory session cache (backed by disk) — capped to prevent OOM
  const MAX_CACHED_SESSIONS = 200;
  const sessions = new Map<string, Session>();

  function evictOldestSession(): void {
    if (sessions.size <= MAX_CACHED_SESSIONS) return;
    // Map iterates in insertion order — oldest first
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }

  function getOrCreateSession(id: string): Session {
    // Try cache first — re-insert to keep LRU order
    let session = sessions.get(id);
    if (session) {
      sessions.delete(id);
      sessions.set(id, session);
      return session;
    }

    // Try disk
    session = sessionStore.load(id) ?? undefined;
    if (session) {
      sessions.set(id, session);
      evictOldestSession();
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
    evictOldestSession();
    return session;
  }

  // Session write queue — serialize writes per session to prevent lost updates
  // when two async handlers modify the same session concurrently
  const sessionWriteQueues = new Map<string, Promise<void>>();

  function saveSession(session: Session): void {
    const prev = sessionWriteQueues.get(session.id) ?? Promise.resolve();
    const next = prev.then(() => {
      sessions.set(session.id, session);
      sessionStore.save(session);
      memoryIndex.markDirty();
    }).catch((err) => {
      console.error(`[session] Save failed for ${session.id}:`, err);
    });
    sessionWriteQueues.set(session.id, next);
    // Clean up the queue entry once it settles to avoid memory leak
    next.finally(() => {
      if (sessionWriteQueues.get(session.id) === next) {
        sessionWriteQueues.delete(session.id);
      }
    });
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
        // Missing token is not a brute-force attempt — don't count as failure
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

    // ── Update checker: compare local version against GitHub ──
    if (method === "GET" && url.pathname === "/api/updates/check") {
      try {
        // Read local version from package.json
        const pkgPath = join(import.meta.dirname || ".", "..", "package.json");
        const localPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const localVersion = localPkg.version || "0.0.0";

        // Get local commit hash if available
        let localCommit = "";
        try {
          const { execSync } = await import("node:child_process");
          localCommit = execSync("git rev-parse --short HEAD", { cwd: join(import.meta.dirname || ".", ".."), encoding: "utf-8" }).trim();
        } catch {}

        // Fetch latest from GitHub (cached for 1 hour)
        const cacheKey = "_updateCache";
        const now = Date.now();
        if ((globalThis as any)[cacheKey] && now - (globalThis as any)[cacheKey].time < 3600000) {
          const cached = (globalThis as any)[cacheKey];
          json(200, { ...cached.data, localVersion, localCommit, cached: true });
          return;
        }

        let remoteVersion = localVersion;
        let remoteCommit = "";
        let updateAvailable = false;
        let releaseNotes = "";

        try {
          // Check latest commit on main
          const commitRes = await fetch("https://api.github.com/repos/petermanrique101-sys/Open-Agent-X/commits/main", {
            headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Open-Agent-X" },
          });
          if (commitRes.ok) {
            const commitData = await commitRes.json() as any;
            remoteCommit = commitData.sha?.slice(0, 7) || "";
            releaseNotes = commitData.commit?.message?.split("\n")[0] || "";
          }

          // Check remote package.json for version
          const pkgRes = await fetch("https://raw.githubusercontent.com/petermanrique101-sys/Open-Agent-X/main/package.json", {
            headers: { "User-Agent": "Open-Agent-X" },
          });
          if (pkgRes.ok) {
            const remotePkg = await pkgRes.json() as any;
            remoteVersion = remotePkg.version || localVersion;
          }

          updateAvailable = (remoteCommit && localCommit && remoteCommit !== localCommit) || remoteVersion !== localVersion;
        } catch {
          // GitHub unreachable — skip update check silently
        }

        const result = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes };
        (globalThis as any)[cacheKey] = { data: result, time: now };
        json(200, result);
      } catch (e) {
        json(200, { updateAvailable: false, error: safeErrorMessage(e) });
      }
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

    // ── Feature 1: Conversation Branching (fork chat at message index) ──
    if (method === "POST" && url.pathname === "/api/sessions/fork") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const sourceId = String(body.sessionId || "");
      const atIndex = typeof body.atIndex === "number" ? body.atIndex : -1;
      if (!sourceId || !isValidSessionId(sourceId)) { json(400, { error: "Invalid session ID" }); return; }
      const source = getOrCreateSession(sourceId);
      if (atIndex < 0 || atIndex >= source.messages.length) { json(400, { error: "Invalid message index" }); return; }
      const forkId = `fork-${sourceId.slice(0, 20)}-${Date.now().toString(36)}`;
      const forkedMessages = source.messages.slice(0, atIndex + 1);
      const forkSession: Session = {
        id: forkId,
        title: `Fork: ${source.title}`,
        messages: JSON.parse(JSON.stringify(forkedMessages)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      (forkSession as any).forkedFrom = sourceId;
      (forkSession as any).forkAtIndex = atIndex;
      sessions.set(forkId, forkSession);
      saveSession(forkSession);
      json(200, { ok: true, forkId, title: forkSession.title, messageCount: forkedMessages.length });
      return;
    }

    // Get fork tree for a session
    if (method === "GET" && url.pathname === "/api/sessions/forks") {
      const sourceId = url.searchParams.get("sessionId") || "";
      if (!sourceId) { json(400, { error: "sessionId required" }); return; }
      const allSessions = sessionStore.list();
      const forks: Array<{ id: string; title: string; forkAtIndex: number; createdAt: number }> = [];
      for (const meta of allSessions) {
        const s = sessionStore.load(meta.id);
        if (s && (s as any).forkedFrom === sourceId) {
          forks.push({ id: s.id, title: s.title, forkAtIndex: (s as any).forkAtIndex || 0, createdAt: s.createdAt });
        }
      }
      // Also check if THIS session is a fork
      const thisSession = sessionStore.load(sourceId);
      const parent = thisSession ? (thisSession as any).forkedFrom || null : null;
      json(200, { forks, parent });
      return;
    }

    // ── Feature 2: Auto-summarize old sessions into memory ──
    if (method === "POST" && url.pathname === "/api/sessions/auto-summarize") {
      const allSessions = sessionStore.list();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days old
      const stale = allSessions.filter(s => s.updatedAt < cutoff && s.messageCount > 4);
      const summaries: Array<{ id: string; title: string; summary: string }> = [];
      const summaryDir = join(dataDir, "memory", "session-summaries");
      mkdirSync(summaryDir, { recursive: true });
      for (const meta of stale.slice(0, 20)) {
        const summaryFile = join(summaryDir, `${meta.id}.md`);
        if (existsSync(summaryFile)) continue; // already summarized
        const session = sessionStore.load(meta.id);
        if (!session) continue;
        // Build a quick extractive summary from messages
        const userMsgs = session.messages.filter(m => m.role === "user" && typeof m.content === "string");
        const assistMsgs = session.messages.filter(m => m.role === "assistant" && typeof m.content === "string");
        const topicLines = userMsgs.slice(0, 5).map(m => `- User: ${String(m.content).slice(0, 120)}`);
        const assistLines = assistMsgs.slice(0, 3).map(m => `- Agent: ${String(m.content).split("\n")[0]?.slice(0, 120)}`);
        const summary = `# ${session.title}\n\nDate: ${new Date(session.createdAt).toISOString().split("T")[0]}\nMessages: ${session.messages.length}\n\n## Key Topics\n${topicLines.join("\n")}\n\n## Key Responses\n${assistLines.join("\n")}`;
        writeFileSync(summaryFile, summary, "utf-8");
        summaries.push({ id: meta.id, title: session.title, summary });
      }
      json(200, { ok: true, summarized: summaries.length, total: stale.length, summaries });
      return;
    }

    // Get session summaries
    if (method === "GET" && url.pathname === "/api/sessions/summaries") {
      const summaryDir = join(dataDir, "memory", "session-summaries");
      if (!existsSync(summaryDir)) { json(200, { summaries: [] }); return; }
      const files = readdirSync(summaryDir).filter(f => f.endsWith(".md"));
      const summaries = files.map(f => {
        const content = readFileSync(join(summaryDir, f), "utf-8");
        const id = f.replace(".md", "");
        const titleMatch = content.match(/^# (.+)$/m);
        return { id, title: titleMatch?.[1] || id, summary: content.slice(0, 500) };
      });
      json(200, { summaries });
      return;
    }

    // ── Feature 3: Cross-session search ──
    if (method === "GET" && url.pathname === "/api/sessions/search") {
      const query = (url.searchParams.get("q") || "").toLowerCase().trim();
      if (!query || query.length < 2) { json(400, { error: "Query too short" }); return; }
      const allSessions = sessionStore.list();
      const results: Array<{ sessionId: string; title: string; matches: Array<{ role: string; snippet: string; index: number }> }> = [];
      for (const meta of allSessions.slice(0, 100)) {
        const session = sessionStore.load(meta.id);
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
      return;
    }

    // ── Feature 5: Mood/tone detection ──
    if (method === "POST" && url.pathname === "/api/mood/detect") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const text = String(body.text || "");
      if (!text) { json(400, { error: "text required" }); return; }

      // Lightweight keyword-based sentiment analysis (no external deps)
      const lower = text.toLowerCase();
      const positiveWords = ["thanks", "great", "awesome", "perfect", "love", "excellent", "amazing", "happy", "good", "nice", "wonderful", "fantastic", "brilliant", "appreciate", "excited", "glad", "pleased", "helpful", "beautiful"];
      const negativeWords = ["frustrated", "angry", "annoyed", "broken", "bug", "wrong", "error", "fail", "hate", "terrible", "awful", "bad", "worst", "stuck", "confused", "disappointed", "problem", "issue", "unfortunately", "sucks"];
      const urgentWords = ["urgent", "asap", "immediately", "critical", "emergency", "deadline", "hurry", "rush"];
      const casualWords = ["hey", "hi", "yo", "lol", "haha", "btw", "nah", "yeah", "cool", "sup", "chill"];
      const formalWords = ["please", "kindly", "would you", "could you", "regarding", "concerning", "pursuant", "hereby"];

      let posScore = 0, negScore = 0, urgentScore = 0, casualScore = 0, formalScore = 0;
      for (const w of positiveWords) { if (lower.includes(w)) posScore++; }
      for (const w of negativeWords) { if (lower.includes(w)) negScore++; }
      for (const w of urgentWords) { if (lower.includes(w)) urgentScore++; }
      for (const w of casualWords) { if (lower.includes(w)) casualScore++; }
      for (const w of formalWords) { if (lower.includes(w)) formalScore++; }

      // Detect exclamation/caps emphasis
      const exclamations = (text.match(/!/g) || []).length;
      const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
      if (exclamations > 2) urgentScore++;
      if (capsRatio > 0.5 && text.length > 10) urgentScore++;

      let mood = "neutral";
      let tone = "balanced";
      let confidence = 0.5;

      if (posScore > negScore && posScore > 0) { mood = "positive"; confidence = Math.min(0.9, 0.5 + posScore * 0.1); }
      else if (negScore > posScore && negScore > 0) { mood = "negative"; confidence = Math.min(0.9, 0.5 + negScore * 0.1); }
      else if (urgentScore > 0) { mood = "urgent"; confidence = Math.min(0.9, 0.5 + urgentScore * 0.15); }

      if (casualScore > formalScore) tone = "casual";
      else if (formalScore > casualScore) tone = "formal";

      // Generate style hint for the agent
      let styleHint = "";
      if (mood === "negative") styleHint = "User seems frustrated. Be empathetic, acknowledge the issue, and focus on solutions.";
      else if (mood === "urgent") styleHint = "User has urgency. Be concise, prioritize action over explanation.";
      else if (mood === "positive") styleHint = "User is in a good mood. Match their energy, be warm and encouraging.";
      if (tone === "casual") styleHint += " Keep responses casual and conversational.";
      else if (tone === "formal") styleHint += " Match their formal tone.";

      json(200, { mood, tone, confidence, styleHint, scores: { positive: posScore, negative: negScore, urgent: urgentScore, casual: casualScore, formal: formalScore } });
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
        const BLOCKED_EXTENSIONS = new Set(["exe", "sh", "bat", "cmd", "com", "ps1", "vbs", "js", "msi", "dll", "so"]);
        if (BLOCKED_EXTENSIONS.has(ext)) {
          json(400, { error: `File type .${ext} is not allowed` });
          return;
        }
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

    // Auth check for static file routes (uploads, videos, images)
    // Accept token via query param or Authorization header
    const staticAuthRoutes = ["/uploads/", "/videos/", "/images/"];
    if (method === "GET" && staticAuthRoutes.some(r => url.pathname.startsWith(r))) {
      const auth = req.headers.authorization || "";
      const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const queryToken = url.searchParams.get("token") || "";
      const providedToken = bearerToken || queryToken;
      const tokenMatch = providedToken.length === config.authToken.length &&
        timingSafeEqual(Buffer.from(providedToken), Buffer.from(config.authToken));
      if (!providedToken || !tokenMatch) {
        json(401, { error: "Authentication required" });
        return;
      }
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
        const headers: Record<string, string> = {
          ...corsHeaders(req),
          "Content-Type": ct[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        };
        // Prevent script execution in SVGs served from uploads
        if (ext === "svg") {
          headers["Content-Security-Policy"] = "script-src 'none'";
        }
        res.writeHead(200, headers);
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

    // ── Security & ARI APIs ──

    if (method === "GET" && url.pathname === "/api/security/dashboard") {
      json(200, getThreatDashboard()); return;
    }
    if (method === "GET" && url.pathname === "/api/security/policies") {
      json(200, listPolicies()); return;
    }
    if (method === "POST" && url.pathname === "/api/security/policies") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      json(200, createPolicy(body)); return;
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/security/policies/")) {
      const id = url.pathname.split("/").pop()!;
      json(200, { ok: deletePolicy(id) }); return;
    }
    if (method === "GET" && url.pathname === "/api/security/egress") {
      json(200, { rules: listEgressRules() }); return;
    }
    if (method === "POST" && url.pathname === "/api/security/egress") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      json(200, addEgressRule(body.domain, body.action, body.reason)); return;
    }
    if (method === "GET" && url.pathname === "/api/security/audit") {
      const query = Object.fromEntries(url.searchParams.entries());
      json(200, await queryAuditLog(query)); return;
    }
    if (method === "GET" && url.pathname === "/api/security/audit/summary") {
      json(200, await getAuditSummary()); return;
    }
    if (method === "GET" && url.pathname === "/api/security/file-access") {
      json(200, getRecentFileAccess(50)); return;
    }
    if (method === "POST" && url.pathname === "/api/security/scan") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      const result = scanForSecrets(String(body.text || ""));
      json(200, result); return;
    }
    if (method === "POST" && url.pathname === "/api/security/benchmarks") {
      const report = await runBenchmarks();
      json(200, report); return;
    }
    if (method === "POST" && url.pathname === "/api/security/injection-tests") {
      const report = runInjectionTests();
      json(200, report); return;
    }

    // ── Reliability & Core APIs ──

    // Health check (Task 39)
    if (method === "GET" && url.pathname === "/api/health") {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      json(200, {
        status: "ok",
        uptime: Math.round(uptime),
        memory: { heapUsedMB: Math.round(mem.heapUsed / 1048576), heapTotalMB: Math.round(mem.heapTotal / 1048576), rssMB: Math.round(mem.rss / 1048576) },
        toolStats: getToolStats(),
        version: "0.1.0",
      }); return;
    }

    // Tool stats (Task 36)
    if (method === "GET" && url.pathname === "/api/tools/stats") {
      json(200, { stats: getToolStats(), successRate: getToolSuccessRate(), recentFailures: getRecentFailures(20) }); return;
    }

    // Crash analytics (Task 50)
    if (method === "GET" && url.pathname === "/api/crashes") {
      json(200, { report: getCrashReport(), topPatterns: getTopCrashPatterns(10) }); return;
    }

    // Context usage (Task 43)
    if (method === "GET" && url.pathname === "/api/context/usage") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          json(200, getContextUsage(session.messages as any, 128000)); return;
        }
      }
      json(200, { used: 0, max: 128000, percentage: 0, remaining: 128000 }); return;
    }

    // Session export/import (Task 49)
    if (method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/export")) {
      const id = url.pathname.split("/")[3];
      const format = (url.searchParams.get("format") || "json") as "json" | "markdown";
      try {
        const result = exportSession(dataDir, id, format);
        json(200, result); return;
      } catch (e) { json(404, { error: safeErrorMessage(e) }); return; }
    }
    if (method === "POST" && url.pathname === "/api/sessions/import") {
      try {
        const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
        const result = await importSession(body);
        json(200, result); return;
      } catch (e) { json(400, { error: safeErrorMessage(e) }); return; }
    }

    // Progressive loading (Task 53)
    if (method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
      const id = url.pathname.split("/")[3];
      const page = parseInt(url.searchParams.get("page") || "0");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "50");
      try {
        const result = await loadSessionPage(id, page, pageSize);
        json(200, result); return;
      } catch (e) { json(404, { error: safeErrorMessage(e) }); return; }
    }

    // Startup tests (Task 55)
    if (method === "GET" && url.pathname === "/api/startup-tests") {
      const results = await runStartupTests();
      json(200, { results }); return;
    }

    // ── Architecture APIs ──

    // API docs (Task 59)
    if (method === "GET" && url.pathname === "/api/docs") {
      json(200, generateFullSpec()); return;
    }

    // Plugins (Task 56)
    if (method === "GET" && url.pathname === "/api/plugins") {
      const pm = new PluginManager();
      json(200, pm.listPlugins()); return;
    }
    if (method === "POST" && url.pathname === "/api/plugins/load") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      const pm = new PluginManager();
      try {
        const plugin = await pm.loadPlugin(String(body.path));
        json(200, { ok: true, plugin }); return;
      } catch (e) { json(400, { error: safeErrorMessage(e) }); return; }
    }
    if (method === "POST" && url.pathname === "/api/plugins/unload") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      const pm = new PluginManager();
      json(200, { ok: pm.unloadPlugin(String(body.id)) }); return;
    }

    // Get voice capabilities
    if (method === "GET" && url.pathname === "/api/voice/capabilities") {
      const { detectCapabilities } = await import("./voice.js");
      json(200, await detectCapabilities());
      return;
    }

    // Proxy voice preview from XTTS server (avoids CORS issues)
    if (method === "GET" && url.pathname.startsWith("/api/voice/preview/")) {
      const voiceId = url.pathname.split("/").pop() || "";
      if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) {
        json(400, { error: "Invalid voice ID" }); return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:7862/voices/${voiceId}/preview`);
        if (r.ok && r.body) {
          const buf = Buffer.from(await r.arrayBuffer());
          res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(buf.length) });
          res.end(buf);
        } else { json(404, { error: "Voice not found" }); }
      } catch { json(502, { error: "XTTS server not reachable" }); }
      return;
    }

    // Start XTTS server
    if (method === "POST" && url.pathname === "/api/voice/start-xtts") {
      try {
        // Check if already running
        try {
          const h = await fetch("http://127.0.0.1:7862/health", { signal: AbortSignal.timeout(1000) });
          if (h.ok) { json(200, { ok: true, status: "already running" }); return; }
        } catch {}
        // Spawn XTTS server as detached process
        const { spawn } = await import("node:child_process");
        const scriptPath = join(process.cwd(), "scripts", "xtts-server.py");
        const child = spawn("python", [scriptPath], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, XTTS_PORT: "7862" },
        });
        child.unref();
        // Wait a moment then check health
        await new Promise(r => setTimeout(r, 2000));
        json(200, { ok: true, status: "started", pid: child.pid });
      } catch (e) {
        json(500, { error: "Failed to start XTTS" });
      }
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
        json(500, { error: "Transcription failed" });
      }
      return;
    }

    // Synthesize speech (TTS)
    if (method === "POST" && url.pathname === "/api/voice/synthesize") {
      try {
        const body = await safeParseBody(req) as {
          text?: string;
          voice?: string;
          speed?: number;
        };
        if (!body.text?.trim()) {
          json(400, { error: "text is required" });
          return;
        }

        const { synthesize } = await import("./voice.js");
        const wavBuffer = await synthesize(body.text, body.voice, body.speed);

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
        json(500, { error: "Synthesis failed" });
      }
      return;
    }

    // ── Sync API ──

    if (method === "GET" && url.pathname === "/api/sync/status") {
      json(200, agentSync.getStatus());
      return;
    }

    if (method === "POST" && url.pathname === "/api/sync/configure") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
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
      const body = await safeParseBody(req) as { name?: string; schedule?: string; prompt?: string; systemJob?: boolean };
      if (!body.name || !body.schedule || !body.prompt) { json(400, { error: "name, schedule, and prompt are required" }); return; }
      try {
        const job = cronService.create(body.name, body.schedule, body.prompt, body.systemJob);
        json(200, { ok: true, job });
      } catch (e) { json(400, { error: safeErrorMessage(e) }); }
      return;
    }
    if (method === "PATCH" && url.pathname.startsWith("/api/cron/")) {
      const id = url.pathname.split("/").pop()!;
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      try {
        const job = cronService.update(id, body);
        if (!job) { json(404, { error: "Job not found" }); return; }
        json(200, { ok: true, job });
      } catch (e) { json(400, { error: safeErrorMessage(e) }); }
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
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
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
        // Invalidate old token immediately by updating in-memory config
        config.authToken = newToken;
        setBrowserAuthContext(newToken, String(config.port));
        const masked = newToken.slice(0, 4) + "****" + newToken.slice(-4);
        console.log(`[auth] Token rotated. New token: ${masked}`);
        json(200, { ok: true, token: newToken, message: "Token rotated. Save this token — it won't be shown again." });
      } catch (e) {
        json(500, { error: "Failed to rotate token" });
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
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    // ── Settings API (server-side persistence) ──

    if (method === "POST" && url.pathname === "/api/settings") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      const settingsPath = join(dataDir, "settings.json");
      let existing: Record<string, unknown> = {};
      try { if (existsSync(settingsPath)) existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      const merged = { ...existing, ...body };
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
      // Also persist port to config.json so it takes effect on restart
      if (body.port) {
        const configPath = join(dataDir, "config.json");
        let cfg: Record<string, unknown> = {};
        try { if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
        cfg.port = parseInt(String(body.port), 10);
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
      }
      json(200, { ok: true });
      return;
    }

    // Available providers (only those with valid keys/auth configured)
    if (method === "GET" && url.pathname === "/api/providers") {
      const { loadTokens } = await import("./auth.js");
      const { loadAnthropicTokens } = await import("./auth-anthropic.js");
      const providers: Array<{ id: string; name: string; models: string[]; active: boolean }> = [];
      // Check each provider
      const hasOpenAIOAuth = !!loadTokens();
      const hasAnthropicOAuth = !!loadAnthropicTokens();
      const hasXaiKey = secretsStore.has("XAI_API_KEY");
      const hasOpenAIKey = !!config.openaiApiKey || secretsStore.has("OPENAI_API_KEY");
      let hasOllama = false;
      try { const r = await fetch("http://127.0.0.1:11434/api/tags"); hasOllama = r.ok; } catch {}

      // Read current provider/model from settings
      let currentProvider = "xai", currentModel = "grok-3-mini";
      try {
        const sp = join(dataDir, "settings.json");
        if (existsSync(sp)) { const s = JSON.parse(readFileSync(sp, "utf-8")); currentProvider = s.provider || "xai"; currentModel = s.model || ""; }
      } catch {}

      const hasGeminiKey = secretsStore.has("GEMINI_API_KEY");
      const hasCustomKey = secretsStore.has("CUSTOM_API_KEY");

      // Order: xAI, Google, OpenAI Codex, Anthropic, OpenAI API, Ollama, Custom
      if (hasXaiKey) providers.push({ id: "xai", name: "xAI Grok", models: ["grok-3-mini", "grok-3", "grok-2"], active: currentProvider === "xai" });
      if (hasGeminiKey) providers.push({ id: "gemini", name: "Google Gemini", models: ["gemini-2.0-flash", "gemini-2.5-pro-preview-05-06", "gemini-2.5-flash-preview-05-20"], active: currentProvider === "gemini" });
      if (hasOpenAIOAuth) providers.push({ id: "codex", name: "OpenAI Codex", models: ["gpt-5.3-codex", "gpt-4o", "gpt-4o-mini", "o3-pro"], active: currentProvider === "codex" });
      if (hasAnthropicOAuth) providers.push({ id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6", "claude-haiku-4-5"], active: currentProvider === "anthropic" });
      if (hasOpenAIKey) providers.push({ id: "openai", name: "OpenAI API", models: ["gpt-4o", "gpt-4o-mini", "o3-pro"], active: currentProvider === "openai" });
      if (hasOllama) {
        let ollamaModels: string[] = [];
        try { const r = await fetch("http://127.0.0.1:11434/api/tags"); const d = await r.json() as any; ollamaModels = (d.models || []).map((m: any) => m.name); } catch {}
        providers.push({ id: "local", name: "Ollama", models: ollamaModels, active: currentProvider === "local" });
      }
      if (hasCustomKey) providers.push({ id: "custom", name: "Custom Provider", models: ["custom-model"], active: currentProvider === "custom" });
      json(200, { providers, current: { provider: currentProvider, model: currentModel } });
      return;
    }

    // Switch provider/model on the fly
    if (method === "POST" && url.pathname === "/api/providers/switch") {
      let body: Record<string, unknown>;
      try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return; }
      const provider = String(body.provider || "");
      const model = String(body.model || "");
      if (!provider) { json(400, { error: "provider required" }); return; }
      // Update settings.json
      const settingsPath = join(dataDir, "settings.json");
      let settings: Record<string, unknown> = {};
      try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      settings.provider = provider;
      if (model) settings.model = model;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      json(200, { ok: true, provider, model: model || settings.model });
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

    // ── Local Models (Ollama) API ──

    if (method === "GET" && url.pathname === "/api/models/local") {
      try {
        const ollamaRes = await fetch("http://127.0.0.1:11434/api/tags");
        if (!ollamaRes.ok) { json(502, { error: "Ollama returned " + ollamaRes.status }); return; }
        const data = await ollamaRes.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
        const models = (data.models || []).map((m: { name: string; size: number; modified_at: string }) => ({
          name: m.name,
          size: m.size,
          modified: m.modified_at,
        }));
        json(200, { models });
      } catch {
        json(502, { error: "Ollama not running. Start it with: ollama serve" });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/ollama/start") {
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn("ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        json(200, { ok: true, message: "Ollama starting..." });
      } catch (e: unknown) {
        json(500, { error: "Failed to start Ollama: " + (e instanceof Error ? e.message : String(e)) });
      }
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        json(400, { error: "Invalid date format. Expected YYYY-MM-DD" }); return;
      }
      const [y, m, d] = date.split("-").map(Number);
      if (m < 1 || m > 12 || d < 1 || d > 31) {
        json(400, { error: "Invalid date values" });
        return;
      }
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
      const body = await safeParseBody(req) as {
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
      if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return; }
      const existed = secretsStore.delete(name);
      json(200, { ok: true, deleted: existed });
      return;
    }

    // ── API Integrations ──

    // List all integrations
    if (method === "GET" && url.pathname === "/api/integrations") {
      json(200, integrations.list());
      return;
    }

    // Get the schema template for creating new integrations
    if (method === "GET" && url.pathname === "/api/integrations/schema") {
      json(200, { schema: IntegrationRegistry.getIntegrationSchema() });
      return;
    }

    // Get a single integration by ID
    if (method === "GET" && url.pathname.startsWith("/api/integrations/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      const config = integrations.get(id);
      if (!config) { json(404, { error: "Integration not found" }); return; }
      json(200, config);
      return;
    }

    // Install/configure an integration (mark installed + save secret)
    if (method === "POST" && url.pathname === "/api/integrations/install") {
      const body = await safeParseBody(req) as { id: string; secretValue?: string };
      const config = integrations.get(body.id);
      if (!config) { json(404, { error: "Integration not found" }); return; }
      // Save the API key/token to secrets vault
      if (body.secretValue) {
        secretsStore.set(config.secretName, body.secretValue, config.name);
      }
      integrations.markInstalled(body.id, true);
      json(200, { ok: true, id: body.id, secretName: config.secretName });
      return;
    }

    // Uninstall an integration (remove secret + mark uninstalled)
    if (method === "POST" && url.pathname === "/api/integrations/uninstall") {
      const body = await safeParseBody(req) as { id: string };
      const config = integrations.get(body.id);
      if (!config) { json(404, { error: "Integration not found" }); return; }
      secretsStore.delete(config.secretName);
      integrations.markInstalled(body.id, false);
      json(200, { ok: true, id: body.id });
      return;
    }

    // Toggle enable/disable
    if (method === "POST" && url.pathname === "/api/integrations/toggle") {
      const body = await safeParseBody(req) as { id: string; enabled: boolean };
      integrations.setEnabled(body.id, body.enabled);
      json(200, { ok: true, id: body.id, enabled: body.enabled });
      return;
    }

    // Add a new custom integration (agent-discovered)
    if (method === "POST" && url.pathname === "/api/integrations") {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
      if (!body.id || !body.name || !body.baseUrl) {
        json(400, { error: "id, name, and baseUrl are required" });
        return;
      }
      body.builtin = false;
      body.installed = false;
      body.enabled = true;
      if (!body.endpoints) body.endpoints = [];
      if (!body.headers) body.headers = {};
      integrations.addIntegration(body);
      json(200, { ok: true, id: body.id });
      return;
    }

    // Delete a custom integration
    if (method === "DELETE" && url.pathname.startsWith("/api/integrations/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { json(400, { error: "Invalid integration ID" }); return; }
      const removed = integrations.removeIntegration(id);
      if (!removed) { json(400, { error: "Cannot delete built-in integration" }); return; }
      json(200, { ok: true, deleted: id });
      return;
    }

    // Test an integration (make a simple GET to its base URL)
    if (method === "POST" && url.pathname === "/api/integrations/test") {
      const body = await safeParseBody(req) as { id: string };
      const config = integrations.get(body.id);
      if (!config) { json(404, { error: "Integration not found" }); return; }
      const token = secretsStore.get(config.secretName);
      if (!token) { json(400, { error: `No credentials found. Save your ${config.secretName} first.` }); return; }
      try {
        // Pick a test URL appropriate for the auth type
        let testUrl: string;
        const headers: Record<string, string> = { ...config.headers };
        if (config.id === "google" && config.authType === "api_key") {
          // API keys only work with public endpoints — test against YouTube
          testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1`;
          headers["X-Goog-Api-Key"] = token;
        } else if (config.authType === "api_key") {
          const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
          testUrl = config.baseUrl + (testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "");
          headers["Authorization"] = `Bearer ${token}`;
        } else {
          const testEndpoint = config.endpoints.find(e => e.method === "GET") || config.endpoints[0];
          testUrl = config.baseUrl + (testEndpoint?.path?.replace(/\{[^}]+\}/g, "") || "");
          headers["Authorization"] = `Bearer ${token}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const r = await fetch(testUrl, { headers, signal: controller.signal });
        clearTimeout(timeout);
        json(200, { ok: r.ok, status: r.status, statusText: r.statusText });
      } catch (e: any) {
        json(200, { ok: false, error: e.message });
      }
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

    // ── WhatsApp (Baileys — QR code scan) ──

    // Connect: starts Baileys, returns QR code to scan
    if (method === "POST" && url.pathname === "/api/whatsapp/connect") {
      try {
        const result = await whatsappBridge.connect();
        json(200, result);
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    // Disconnect: cleanly close WhatsApp connection
    if (method === "POST" && url.pathname === "/api/whatsapp/disconnect") {
      await whatsappBridge.disconnect();
      json(200, { ok: true });
      return;
    }

    // Reset: clear saved session, force new QR scan
    if (method === "POST" && url.pathname === "/api/whatsapp/reset") {
      await whatsappBridge.reset();
      json(200, { ok: true });
      return;
    }

    // Status: connection state, QR code, phone number
    if (method === "GET" && url.pathname === "/api/whatsapp/status") {
      json(200, await whatsappBridge.getStatus());
      return;
    }

    // Send a message (agent-initiated or test)
    if (method === "POST" && url.pathname === "/api/whatsapp/send") {
      try {
        const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
        const { to, message: msg } = body;
        if (!to || !msg) {
          json(400, { error: "to and message are required" });
          return;
        }
        const ok = await whatsappBridge.sendMessage(to, msg);
        json(ok ? 200 : 500, { ok, error: ok ? undefined : "Failed to send" });
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    // Set allowed numbers (security: only these numbers can message the agent)
    if (method === "POST" && url.pathname === "/api/whatsapp/allowed-numbers") {
      try {
        const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
        const numbers: string[] = body.numbers || [];
        whatsappBridge.setAllowedNumbers(numbers);
        json(200, { ok: true, numbers });
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    // ── Telegram Bot ──

    if (method === "POST" && url.pathname === "/api/telegram/connect") {
      try {
        const result = await telegramBridge.connect();
        json(200, result);
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/telegram/disconnect") {
      telegramBridge.disconnect();
      json(200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/telegram/status") {
      json(200, { ...telegramBridge.getStatus(), hasToken: secretsStore.has("TELEGRAM_BOT_TOKEN") });
      return;
    }

    if (method === "POST" && url.pathname === "/api/telegram/send") {
      try {
        const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return; }
        const { chatId, message: msg } = body;
        if (!chatId || !msg) { json(400, { error: "chatId and message are required" }); return; }
        const ok = await telegramBridge.sendMessage(chatId, msg);
        json(ok ? 200 : 500, { ok });
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    // Chat (SSE streaming)
    if (method === "POST" && url.pathname === "/api/chat") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req), (key, value) => BANNED_KEYS.has(key) ? undefined : value);
      } catch {
        json(400, { error: "Invalid JSON body" });
        return;
      }
      if (typeof body.message !== "string" || !body.message.trim()) {
        json(400, { error: "message is required and must be a string" });
        return;
      }
      const message: string = body.message;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "default";
      const attachments = Array.isArray(body.attachments) ? body.attachments as Array<{ name: string; url: string; isImage: boolean }> : [];

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

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        // Provider: use saved preference from settings, fall back to auto-detect
        const { loadTokens } = await import("./auth.js");
        const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");

        let savedProvider: string | null = null;
        let savedModel: string | null = null;
        try {
          const settingsPath = join(dataDir, "settings.json");
          if (existsSync(settingsPath)) {
            const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
            savedProvider = savedSettings.provider || null;
            savedModel = savedSettings.model || null;
          }
        } catch {}

        let provider: "codex" | "xai" | "openai" | "anthropic" | "local" | "gemini" | "custom";
        if (savedProvider && ["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"].includes(savedProvider)) {
          provider = savedProvider as typeof provider;
        } else if (loadAnthropicTokens()) {
          provider = "anthropic";
        } else if (loadTokens() && !config.openaiApiKey) {
          provider = "codex";
        } else {
          provider = "xai";
        }

        let apiKey: string;
        let customBaseURL: string | undefined;
        if (provider === "local") {
          apiKey = "ollama";
        } else if (provider === "anthropic") {
          apiKey = await getAnthropicApiKey();
        } else if (provider === "xai") {
          apiKey = secretsStore.get("XAI_API_KEY") || "";
          if (!apiKey) { sseWrite(res, { type: "error", message: "No xAI API key configured. Go to Settings → AI tab and enter your key." }); res.end(); return; }
        } else if (provider === "gemini") {
          apiKey = secretsStore.get("GEMINI_API_KEY") || "";
          if (!apiKey) { sseWrite(res, { type: "error", message: "No Google API key configured. Go to Settings → AI tab and enter your key from ai.google.dev." }); res.end(); return; }
        } else if (provider === "custom") {
          apiKey = secretsStore.get("CUSTOM_API_KEY") || "";
          if (!apiKey) { sseWrite(res, { type: "error", message: "No API key configured for custom provider. Go to Settings → AI tab." }); res.end(); return; }
          try { const sp = join(dataDir, "settings.json"); if (existsSync(sp)) { const ss = JSON.parse(readFileSync(sp, "utf-8")); customBaseURL = ss.customBaseUrl || undefined; } } catch {}
        } else if (provider === "openai" && !config.openaiApiKey) {
          apiKey = secretsStore.get("OPENAI_API_KEY") || await getApiKey(config.openaiApiKey);
        } else {
          apiKey = await getApiKey(config.openaiApiKey);
        }

        // Wire up SSE writer so request_secret can emit to the active stream
        // Register with WebSocket chat manager for multi-client broadcast
        const wsChat = chatWs.startChat(sessionId);
        const onEvent = (event: ServerEvent) => {
          sseWrite(res, event);    // SSE to the original requester
          wsChat.onEvent(event);   // WS to all subscribed clients
        };
        activeOnEvent = onEvent;

        // SSE keepalive — prevents connection drop during long tool calls (browser launch, etc.)
        heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": heartbeat\n\n");
          else clearInterval(heartbeat);
        }, 15_000);

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

        // ── Feature 4: Smart Context Window ──
        // Score relevance of session summaries to current message and inject top matches
        let smartContext = "";
        try {
          const summaryDir = join(dataDir, "memory", "session-summaries");
          if (existsSync(summaryDir)) {
            const summaryFiles = readdirSync(summaryDir).filter(f => f.endsWith(".md"));
            const queryWords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            if (queryWords.length > 0 && summaryFiles.length > 0) {
              const scored = summaryFiles.map(f => {
                const content = readFileSync(join(summaryDir, f), "utf-8");
                const lower = content.toLowerCase();
                let score = 0;
                for (const w of queryWords) { if (lower.includes(w)) score++; }
                return { file: f, content: content.slice(0, 400), score };
              }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
              if (scored.length > 0) {
                smartContext = "\n\n--- RELATED PAST SESSIONS (auto-retrieved) ---\n" +
                  scored.map(s => s.content).join("\n---\n") +
                  "\n--- END RELATED SESSIONS ---";
              }
            }
          }
        } catch {}

        // ── Memory Orchestrator: ONE call coordinates all 33 memory modules ──
        let memoryContext = "";
        let memoryNotifications: Array<{type: string, message: string, priority: number}> = [];
        try {
          const { processMessage } = await import("./memory-orchestrator.js");
          const orchestratorResult = await processMessage({
            message,
            sessionId,
            sessionMessages: session.messages.slice(-20).map((m: any) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })),
            timeOfDay: new Date().getHours(),
            dayOfWeek: new Date().getDay(),
            agentPreviousMessage: session.messages.filter((m: any) => m.role === "assistant").pop()?.content as string || undefined,
          });
          memoryContext = orchestratorResult.contextInjection ? `\n\n${orchestratorResult.contextInjection}` : "";
          memoryNotifications = orchestratorResult.notifications || [];
          if (orchestratorResult.debug) {
            console.log(`[memory] Orchestrator: ${orchestratorResult.debug.modulesActivated.length} modules, ${orchestratorResult.debug.totalTimeMs}ms`);
          }
        } catch (e) {
          console.warn("[memory] Orchestrator error (falling back to basic):", (e as Error).message);
        }

        // Initialize threat engine for this session
        const threatEngine = new ThreatEngine(dataDir, sessionId);
        let canaryBuffer = ""; // Rolling buffer for chunk-boundary canary detection
        let fullResponseText = ""; // Full accumulated response for deep canary scan

        // Inject provider awareness + canary tokens + connected integrations into system prompt
        const providerNames: Record<string, string> = { codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok", openai: "OpenAI", local: "Local (Ollama)" };
        const providerHint = `\n\n[System: You are currently powered by ${providerNames[provider] || provider}, model: ${savedModel || "default"}. If asked what LLM you are running on, be transparent about this.]`;
        const integrationsContext = integrations.getAgentContext();

        // Inject milestone/follow-up notifications so agent can weave them into response
        let notificationHint = "";
        if (memoryNotifications.length > 0) {
          const topNotifs = memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
          notificationHint = "\n\n[Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | ") + "]";
        }

        const enrichedPrompt =
          config.systemPrompt + providerHint + contextBlock + relevantMemories + smartContext + memoryContext + notificationHint + integrationsContext + threatEngine.getCanaryBlock();

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

        // Set parent session ID so spawned agents get parent context
        try { const { PrimalOrchestrator: PO } = await import("./swarm/primal.js"); PO.getInstance().currentSessionId = sessionId; } catch {}

        const result = await runAgent(message, sanitizeHistory(historyToSend), {
          apiKey,
          model: savedModel || (provider === "codex" ? "gpt-5.3-codex" : provider === "anthropic" ? "claude-sonnet-4-6" : provider === "gemini" ? "gemini-2.0-flash" : config.model),
          provider,
          baseURL: customBaseURL,
          systemPrompt: enrichedPrompt,
          tools: primalOnlyTools,
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

        // Track tool usage for cross-session learning
        try {
          const { CrossSessionLearner } = await import("./cross-session-learning.js");
          const csl = CrossSessionLearner.getInstance();
          const toolCalls = result.messages.filter((m: any) => m.tool_calls).flatMap((m: any) => m.tool_calls || []);
          for (const tc of toolCalls) {
            csl.recordAction(sessionId, { type: "tool", details: tc.function?.name || tc.name || "unknown", timestamp: Date.now() });
          }
        } catch {}

        // Persist to disk
        saveSession(session);

        // Send done event BEFORE post-processing so frontend unlocks immediately
        sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        clearInterval(heartbeat);
        res.end();

        // Bridge forwarding: if typed from web UI in a bridge session,
        // forward the reply to the original platform
        if (sessionId.startsWith("wa-") && assistantReply) {
          whatsappBridge.sendMessage(sessionId.slice(3), assistantReply).catch(() => {});
        }
        if (sessionId.startsWith("tg-") && assistantReply) {
          telegramBridge.sendMessage(sessionId.slice(3), assistantReply).catch(() => {});
        }

        // Agent Sync: push after chat (background, non-blocking)
        agentSync.onChatEnd().catch(() => {});
      } catch (e) {
        sseWrite(res, { type: "error", message: safeErrorMessage(e) });
        sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        clearInterval(heartbeat);
        res.end();
      }
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
        json(500, { error: safeErrorMessage(e) });
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
        json(500, { error: safeErrorMessage(e) });
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
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
      try {
        const { deleteAnthropicTokens } = await import("./auth-anthropic.js");
        deleteAnthropicTokens();
        json(200, { ok: true });
      } catch (e) {
        json(500, { error: safeErrorMessage(e) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
      const { loadAnthropicTokens } = await import("./auth-anthropic.js");
      const tokens = loadAnthropicTokens();
      // Also check if Claude CLI is installed
      let cliInstalled = false;
      try {
        const { execSync } = await import("node:child_process");
        execSync("claude --version", { timeout: 5000, stdio: "pipe" });
        cliInstalled = true;
      } catch {}
      json(200, {
        authenticated: !!tokens,
        method: tokens ? "oauth" : "none",
        expired: tokens ? Date.now() > tokens.expiresAt : false,
        cliInstalled,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/anthropic/install-cli") {
      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        const { stdout, stderr } = await execAsync("npm install -g @anthropic-ai/claude-code", {
          timeout: 120_000,
        });
        // Verify it installed
        let version = "unknown";
        try {
          const { execSync } = await import("node:child_process");
          version = execSync("claude --version", { timeout: 5000, stdio: "pipe" }).toString().trim();
        } catch {}
        json(200, { ok: true, version, output: (stdout + stderr).slice(-500) });
      } catch (e) {
        json(500, { error: `Install failed: ${safeErrorMessage(e)}` });
      }
      return;
    }

    // Serve generated videos (e.g. /videos/my_video_123.mp4)
    if (method === "GET" && url.pathname.startsWith("/videos/")) {
      const videosDir = resolve(process.cwd(), "workspace", "videos");
      const vidFile = resolve(videosDir, url.pathname.replace("/videos/", ""));
      const vidRel = relative(videosDir, vidFile);
      if (vidRel.startsWith("..") || vidRel.includes("..") || url.pathname.includes("\x00") || url.pathname.includes("%00") || (existsSync(vidFile) && !realpathSync(vidFile).startsWith(realpathSync(videosDir)))) {
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
      if (imgRel.startsWith("..") || imgRel.includes("..") || url.pathname.includes("\x00") || url.pathname.includes("%00") || (existsSync(imgFile) && !realpathSync(imgFile).startsWith(realpathSync(imagesDir)))) {
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
          headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
          headers["X-XSS-Protection"] = "1; mode=block";
          headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
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

      // Path traversal protection: ensure resolved path stays within publicDir
      const dashRel = relative(publicDir, resolve(filePath));
      if (dashRel.startsWith("..") || dashRel.includes("..")) {
        json(403, { error: "Path traversal blocked" });
        return;
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
          headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
          headers["X-XSS-Protection"] = "1; mode=block";
          headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
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

  // Run database migrations on startup (Task 54)
  runMigrations(dataDir).catch(e => console.warn("[migrations]", e.message));

  // Initialize event bus (Task 60)
  const eventBus = EventBus.getInstance();

  // Wire spawned agent execution — when Primal spawns an agent, actually run it
  eventBus.on("primal:agent-run", async (data: any) => {
    const { agentId, task, systemPrompt, role, parentSessionId } = data;
    console.log(`[primal] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);

    // Build parent context from the conversation that spawned this agent
    let parentContext = "";
    if (parentSessionId) {
      const parentSession = sessions.get(parentSessionId);
      if (parentSession && parentSession.messages.length > 0) {
        const recent = parentSession.messages.slice(-10);
        const summary = recent
          .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m: any) => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`)
          .join("\n");
        parentContext = `\n\n--- PARENT CONVERSATION CONTEXT ---\nYou were spawned from a conversation. Here is recent context:\n${summary}\n--- END PARENT CONTEXT ---\n`;
        console.log(`[primal] Agent ${agentId} received parent context from session ${parentSessionId}`);
      }
    }
    try {
      // Resolve API key and provider from saved settings (same as chat handler)
      let agentProvider: "codex" | "anthropic" | "openai" | "xai" | "local" = "codex";
      try {
        const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf-8"));
        if (saved.provider) agentProvider = saved.provider;
      } catch {}
      const { getApiKey: getKey } = await import("./auth.js");
      const { getAnthropicApiKey: getAnthKey } = await import("./auth-anthropic.js");
      const agentApiKey = agentProvider === "anthropic"
        ? await getAnthKey()
        : await getKey(config.openaiApiKey);

      const agentSession: Session = {
        id: `agent-${agentId}`,
        title: `Agent: ${role}`,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      // Match model to provider (same logic as main chat)
      let savedModel = "";
      try {
        const saved = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf-8"));
        if (saved.model) savedModel = saved.model;
      } catch {}
      const agentModel = savedModel || (agentProvider === "codex" ? "gpt-5.3-codex" : agentProvider === "anthropic" ? "claude-sonnet-4-6" : config.model);

      // Spawned agents get work tools only (no agent_*, swarm_*, delegate — prevents recursion)
      const spawnedAgentTools = tools.filter(t =>
        !t.name.startsWith("agent_") && !t.name.startsWith("swarm_") && t.name !== "delegate"
      );

      // Timeout: 2 minutes per agent
      const agentAbort = new AbortController();
      const agentTimeout = setTimeout(() => {
        agentAbort.abort();
        console.warn(`[primal] Agent ${agentId} (${role}) timed out after 2 minutes`);
      }, 120000);

      const result = await runAgent(task, agentSession.messages, {
        apiKey: agentApiKey,
        model: agentModel,
        provider: agentProvider,
        systemPrompt: (systemPrompt || `You are a ${role} agent. Complete the following task thoroughly. Use the tools available to create files, run commands, and get the job done. Report your results when finished.`) + parentContext,
        tools: spawnedAgentTools,
        security,
        toolPolicy,
        sessionId: `agent-${agentId}`,
        maxIterations: config.maxIterations,
        temperature: config.temperature,
        signal: agentAbort.signal,
        onEvent: (event) => {
          if (event.type === "stream" && event.delta) {
            eventBus.emit("primal:agent-output", { agentId, output: event.delta });
          }
          if (event.type === "tool_start") {
            console.log(`[primal] Agent ${agentId} tool: ${event.toolName}`);
            eventBus.emit("primal:agent-output", { agentId, output: `[tool] ${event.toolName}...` });
          }
          // Auto-approve all tool calls for spawned agents (no user to confirm)
          if (event.type === "tool_start" && event.requiresApproval) {
            event.requiresApproval = false;
          }
        },
      });
      clearTimeout(agentTimeout);
      const finalMessage = result.messages.filter((m: any) => m.role === "assistant").pop();
      const content = typeof finalMessage?.content === "string" ? finalMessage.content : JSON.stringify(finalMessage?.content || "");
      eventBus.emit("primal:agent-result", { agentId, result: content, success: true });
      console.log(`[primal] Agent ${agentId} (${role}) completed`);
    } catch (e) {
      eventBus.emit("primal:agent-result", { agentId, result: safeErrorMessage(e), success: false });
      console.error(`[primal] Agent ${agentId} (${role}) failed:`, (e as Error).message);
    }
  });

  // Forward agent events to WebSocket clients (Mission Control UI)
  eventBus.on("primal:agent-spawn", (data: any) => {
    broadcastAll({ type: "agent-spawn", ...data });
  });
  eventBus.on("primal:agent-output", (data: any) => {
    broadcastAll({ type: "agent-output", ...data });
  });
  eventBus.on("primal:agent-result", (data: any) => {
    broadcastAll({ type: "agent-complete", ...data });
  });
  eventBus.on("primal:agent-redirect", (data: any) => {
    broadcastAll({ type: "agent-update", ...data, status: "redirected" });
  });

  // Initialize response cache (Task 51)
  const responseCache = new ResponseCache();

  // Config hot-reload (Task 61)
  const configWatcher = new ConfigWatcher();
  configWatcher.start(join(dataDir, "config.json"), (newConfig) => {
    console.log("[config] Hot-reloaded config");
  });

  // WebSocket chat system — enables multi-chat, reconnect, stop button
  const chatWs = setupChatWebSocket(server, config.authToken);

  server.listen(config.port, "127.0.0.1", () => {
    const maskedToken = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
    console.log(`\n  Open Agent X running at http://127.0.0.1:${config.port}`);
    console.log(`  Auth token: ${maskedToken}`);
    const displayUrl = `http://127.0.0.1:${config.port}/?token=${maskedToken}`;
    console.log(`\n  ► Open: ${displayUrl}\n`);
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

        // Cron jobs use workspace-scoped file access to prevent filesystem escape
        const { SecurityLayer } = await import("./security.js");
        const cronSecurity = new SecurityLayer(
          resolve(process.env.SAX_WORKSPACE || join(homedir(), ".sax", "workspace")),
          "workspace",
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
    secretsStore.destroy();
    process.exit(0);
  });

  return server;
}
