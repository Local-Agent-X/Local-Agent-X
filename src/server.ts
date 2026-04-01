import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { runAgent } from "./agent.js";
import { allTools, createHttpRequestTool } from "./tools.js";
import { appTools } from "./app-tools.js";
import { issueTools } from "./issue-tools.js";
import { SecurityLayer } from "./security.js";
import { loadToolPolicy } from "./tool-policy.js";
import { getApiKey } from "./auth.js";
import { SessionStore, MemoryIndex, createMemoryTools, buildContextBlock, autoSearchContext, ensurePersonalityFiles } from "./memory.js";
import { SecretsStore } from "./secrets.js";
import { createSecretTools } from "./secret-tools.js";
import { AgentSync } from "./sync.js";
import { RBACManager, type Role } from "./rbac.js";
import { createBrowserTools } from "./browser-tools.js";
import { closeAllBrowsers, setBrowserAuthContext } from "./browser.js";
import { setupChatWebSocket, broadcastAll } from "./chat-ws.js";
import { runSecurityAudit, printAuditReport } from "./security-audit.js";
import { startAriKernel } from "./ari-kernel.js";
import { CronService, createCronTools } from "./cron-service.js";
import { imageTools } from "./image-tools.js";
import { createMissionTools } from "./missions.js";
import { createAllMissionTools } from "./missions/index.js";
import { IntegrationRegistry } from "./integrations.js";
import { WhatsAppBridge } from "./whatsapp-bridge.js";
import { TelegramBridge } from "./telegram-bridge.js";
import { enqueue } from "./execution-lanes.js";
import { formatForChannel, getChannelConfig } from "./channel-formatter.js";
import { resolveSession, buildChannelContext, type ChannelType } from "./session-router.js";
import { detectInjection } from "./sanitize.js";
import { runMigrations } from "./db-migrations.js";
import { EventBus } from "./event-bus.js";
import { AppRegistry } from "./app-runtime.js";
import { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore, type AgentRun } from "./agent-store.js";
import { ConfigWatcher } from "./config-hot-reload.js";
import { createSwarmTools } from "./swarm/index.js";
import { createPrimalTools } from "./swarm/primal.js";
import type { SAXConfig, ServerEvent, Session } from "./types.js";
import type { ServerContext } from "./server-context.js";
import { parseMultipart, extractAgentOutput, safeErrorMessage, jsonResponse, corsHeaders, isLoopbackOrigin, checkRateLimit, getRateLimitKey, recordAuthFailure, getAuthFloodGuard, setServerPort } from "./server-utils.js";
import { handleSessionRoutes, handleSecurityRoutes, handleMemoryRoutes, handleAgentRoutes, handleAppRoutes, handleSettingsRoutes, handleBridgeRoutes, handleChatRoutes } from "./routes/index.js";

export function startServer(config: SAXConfig) {
  setServerPort(String(config.port || 7007));
  const security = new SecurityLayer(config.workspace);
  const publicDir = join(import.meta.dirname || ".", "..", "public");
  const dataDir = join(homedir(), ".sax");
  for (const d of ["apps", "images", "videos"]) mkdirSync(join(resolve(config.workspace), d), { recursive: true });
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);
  setBrowserAuthContext(config.authToken, String(config.port));

  // Services
  const agentSync = new AgentSync(dataDir, () => secretsStore.get("GITHUB_SYNC_TOKEN"));
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  const memoryTools = createMemoryTools(memoryIndex);
  ensurePersonalityFiles(join(dataDir, "memory"));
  const secretsStore = new SecretsStore(dataDir);
  import("./image-tools.js").then(m => m.initImageTools?.(secretsStore)).catch(() => {});
  const cronService = new CronService(dataDir);
  const integrations = new IntegrationRegistry(dataDir);

  // Resolve saved settings for provider/model
  function loadSavedSettings() {
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) return JSON.parse(readFileSync(sp, "utf-8"));
    } catch {} return {};
  }
  async function resolveProviderAndKey(saved: any): Promise<{ provider: string; apiKey: string; model: string }> {
    const { loadTokens } = await import("./auth.js");
    const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");
    let provider = saved.provider || "";
    if (!["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"].includes(provider)) {
      provider = loadAnthropicTokens() ? "anthropic" : (loadTokens() && !config.openaiApiKey) ? "codex" : "xai";
    }
    let apiKey: string;
    if (provider === "local") apiKey = "ollama";
    else if (provider === "anthropic") apiKey = await getAnthropicApiKey();
    else if (provider === "xai") apiKey = secretsStore.get("XAI_API_KEY") || "";
    else if (provider === "openai" && !config.openaiApiKey) apiKey = secretsStore.get("OPENAI_API_KEY") || await getApiKey(config.openaiApiKey);
    else apiKey = await getApiKey(config.openaiApiKey);
    const model = saved.model || (provider === "codex" ? "gpt-5.3-codex" : provider === "anthropic" ? "claude-sonnet-4-6" : config.model);
    return { provider, apiKey, model };
  }

  // Bridge message handler (shared by WhatsApp & Telegram)
  async function bridgeMessageHandler(platform: string, { from, name, text, sessionId }: { from: string; name: string; text: string; sessionId: string }): Promise<string> {
    const saved = loadSavedSettings();
    const { provider, apiKey, model } = await resolveProviderAndKey(saved);
    const channelType = platform.toLowerCase() as ChannelType;
    const route = resolveSession(channelType, from, sessionId);
    const session = getOrCreateSession(route.sessionKey);
    if (session.messages.length === 0) session.title = `${platform}: ${name}`;
    const [contextBlock, relevantMemories] = await Promise.all([buildContextBlock(memoryIndex), autoSearchContext(memoryIndex, text)]);
    const channelConfig = getChannelConfig(channelType);
    const enrichedPrompt = config.systemPrompt + contextBlock + relevantMemories + integrations.getAgentContext() +
      `\n\n[${platform} bridge] ${buildChannelContext(route)}. Message from ${name} (${from}). ` +
      `Keep responses concise — max ~${channelConfig.maxTextLength === Infinity ? "unlimited" : channelConfig.maxTextLength} chars. ` +
      (channelConfig.markdownFlavor === "plain" ? "Use plain text only. " : channelConfig.markdownFlavor === "whatsapp" ? "Use minimal formatting. " : "");
    const injectionScore = detectInjection(text).reduce((max, h) => Math.max(max, h.score), 0);
    if (injectionScore >= 0.85) return `I can't process that message — it was flagged by security filters.`;
    const result = await enqueue("main", () => runAgent(text, session.messages, {
      apiKey, model, provider: provider as any, systemPrompt: enrichedPrompt, tools: bridgeTools, security, toolPolicy, rbac, callerRole: "user" as const,
      sessionId: route.sessionKey, maxIterations: (typeof saved.maxIterations === "number" ? saved.maxIterations : null) || config.maxIterations,
      temperature: typeof saved.temperature === "number" ? saved.temperature : config.temperature,
    }), { label: `bridge:${platform}:${from}` });
    session.messages = result.messages.filter(m => m.role !== "system" && (m.content || (m as any).tool_calls));
    session.updatedAt = Date.now(); saveSession(session);
    return formatForChannel(result.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => m.content as string).pop() || "Done.", channelType).join("\n\n");
  }

  // Bridges
  const whatsappBridge = new WhatsAppBridge({ dataDir, onMessage: (p) => bridgeMessageHandler("WhatsApp", p) });
  const telegramBridge = new TelegramBridge({ dataDir, getToken: () => secretsStore.get("TELEGRAM_BOT_TOKEN") ?? null, onMessage: (p) => bridgeMessageHandler("Telegram", p) });
  if (secretsStore.has("TELEGRAM_BOT_TOKEN")) telegramBridge.connect().then(r => { if (r.state === "connected") console.log(`[telegram] Auto-reconnected as @${r.botUsername}`); }).catch(() => {});

  // Tools
  let activeOnEvent: ((event: ServerEvent) => void) | undefined;
  const secretTools = createSecretTools(secretsStore, undefined);
  secretTools[0].execute = async (args, signal) => { const { createSecretTools: f } = await import("./secret-tools.js"); return f(secretsStore, activeOnEvent)[0].execute(args, signal); };
  const httpRequestTool = createHttpRequestTool(secretsStore);
  let activeBrowserSessionId = "default";
  const browserTools = createBrowserTools(() => activeBrowserSessionId);
  const allAgentTools = [...allTools, httpRequestTool, ...createMemoryTools(memoryIndex), ...secretTools, ...browserTools, ...imageTools, ...createMissionTools(), ...createAllMissionTools(), ...createCronTools(cronService), ...createSwarmTools(), ...createPrimalTools(), ...appTools, ...issueTools];
  const bridgeTools = [...allTools, ...memoryTools, ...imageTools, ...createMissionTools(), ...issueTools];

  // Session management
  const MAX_CACHED = 200;
  const sessions = new Map<string, Session>();
  function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (s) { sessions.delete(id); sessions.set(id, s); return s; }
    s = sessionStore.load(id) ?? undefined;
    if (s) { sessions.set(id, s); if (sessions.size > MAX_CACHED) sessions.delete(sessions.keys().next().value!); return s; }
    s = { id, title: "New Mission", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(id, s); if (sessions.size > MAX_CACHED) sessions.delete(sessions.keys().next().value!); return s;
  }
  const writeQueues = new Map<string, Promise<void>>();
  function saveSession(session: Session): void {
    const prev = writeQueues.get(session.id) ?? Promise.resolve();
    const next = prev.then(() => { sessions.set(session.id, session); sessionStore.save(session); memoryIndex.markDirty(); }).catch(e => console.error(`[session] Save failed:`, e));
    writeQueues.set(session.id, next);
    next.finally(() => { if (writeQueues.get(session.id) === next) writeQueues.delete(session.id); });
  }

  // Stores
  const agentRunStore = AgentRunStore.getInstance();
  const agentTemplateStore = AgentTemplateStore.getInstance();
  const issueStore = IssueStore.getInstance();
  const projectStore = ProjectStore.getInstance();

  // Request handler
  const requestHandler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    const method = req.method || "GET";
    const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
    if (method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); res.end(); return; }
    // CSRF guard
    if (url.pathname.startsWith("/api/") && method !== "GET") {
      if (req.headers["sec-fetch-site"] === "cross-site") { json(403, { error: "Cross-origin mutation blocked" }); return; }
      if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) { json(403, { error: "Cross-origin request blocked" }); return; }
    }
    // Rate limit
    if (url.pathname.startsWith("/api/") && !checkRateLimit(getRateLimitKey(req))) { json(429, { error: "Rate limit exceeded." }); return; }
    // Auth
    let requestRole: Role = "operator";
    const authExempt = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/status", "/api/auth/anthropic/login", "/api/auth/anthropic/logout", "/api/auth/anthropic/status"]);
    if (url.pathname.startsWith("/api/") && !authExempt.has(url.pathname)) {
      const clientIp = req.socket.remoteAddress || "unknown";
      const token = (req.headers.authorization || "").startsWith("Bearer ") ? (req.headers.authorization || "").slice(7) : "";
      const lockout = getAuthFloodGuard().get(clientIp);
      if (lockout && lockout.lockedUntil > Date.now()) { res.writeHead(429, { ...corsHeaders(req), "Retry-After": String(Math.ceil((lockout.lockedUntil - Date.now()) / 1000)) }); res.end(JSON.stringify({ error: "Too many failed attempts." })); return; }
      if (!token) { json(401, { error: "Unauthorized" }); return; }
      const authResult = rbac.authenticate(token);
      if (!authResult.valid || !authResult.entry) { recordAuthFailure(clientIp); json(401, { error: "Unauthorized" }); return; }
      getAuthFloodGuard().delete(clientIp); requestRole = authResult.entry.role;
      const ep = rbac.checkEndpoint(requestRole, method, url.pathname);
      if (!ep.allowed) { json(403, { error: ep.reason }); return; }
    }
    // Build context
    const ctx: ServerContext = {
      config, security, toolPolicy, rbac, dataDir, publicDir, sessionStore, memoryIndex, secretsStore, cronService, integrations,
      whatsappBridge, telegramBridge, agentSync, appRegistry: AppRegistry.getInstance(), agentRunStore, agentTemplateStore, issueStore, projectStore,
      allAgentTools, bridgeTools, getOrCreateSession, saveSession, chatWs, broadcastAll,
      activeOnEvent, setActiveOnEvent: (fn) => { activeOnEvent = fn; }, activeBrowserSessionId, setActiveBrowserSessionId: (id) => { activeBrowserSessionId = id; },
    };
    // Route delegation
    for (const h of [handleSessionRoutes, handleChatRoutes, handleMemoryRoutes, handleSecurityRoutes, handleAgentRoutes, handleAppRoutes, handleBridgeRoutes, handleSettingsRoutes]) {
      if (await h(method, url, req, res, ctx, requestRole)) return;
    }
    // Upload endpoint
    if (method === "POST" && url.pathname === "/api/upload") {
      const uploadsDir = join(dataDir, "uploads"); mkdirSync(uploadsDir, { recursive: true });
      const chunks: Buffer[] = []; let totalSize = 0;
      for await (const chunk of req) { totalSize += (chunk as Buffer).length; if (totalSize > 100 * 1024 * 1024) { json(413, { error: "File too large. Max 100MB." }); req.destroy(); return; } chunks.push(chunk as Buffer); }
      const ct = req.headers["content-type"] || "";
      const bm = ct.match(/boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/);
      if (!bm) { json(400, { error: "Multipart form data required" }); return; }
      const boundary = bm[1] || bm[2];
      if (!boundary || boundary.length > 70 || /[^\x20-\x7e]/.test(boundary)) { json(400, { error: "Invalid boundary" }); return; }
      const parts = parseMultipart(Buffer.concat(chunks), boundary);
      const MAGIC: Record<string, Buffer[]> = { png: [Buffer.from([0x89, 0x50, 0x4E, 0x47])], jpg: [Buffer.from([0xFF, 0xD8, 0xFF])], jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])], gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")], webp: [Buffer.from("RIFF")], bmp: [Buffer.from("BM")], pdf: [Buffer.from("%PDF")] };
      const BLOCKED = new Set(["exe", "sh", "bat", "cmd", "com", "ps1", "vbs", "js", "msi", "dll", "so"]);
      const uploaded: { name: string; url: string; size: number; isImage: boolean }[] = [];
      for (const part of parts) {
        const ext = (part.filename?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (BLOCKED.has(ext)) { json(400, { error: `File type .${ext} not allowed` }); return; }
        const sigs = MAGIC[ext]; if (sigs && !sigs.some(s => part.data.length >= s.length && part.data.subarray(0, s.length).equals(s))) { json(400, { error: `File ${part.filename} doesn't match type .${ext}` }); return; }
        const safeName = `${randomBytes(8).toString("hex")}.${ext}`;
        writeFileSync(join(uploadsDir, safeName), part.data);
        uploaded.push({ name: part.filename || safeName, url: `/uploads/${safeName}`, size: part.data.length, isImage: /^(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(ext) });
      }
      json(200, { files: uploaded }); return;
    }
    // Static auth for /uploads/, /videos/, /images/
    if (method === "GET" && ["/uploads/", "/videos/", "/images/"].some(r => url.pathname.startsWith(r))) {
      const provided = ((req.headers.authorization || "").startsWith("Bearer ") ? (req.headers.authorization || "").slice(7) : "") || url.searchParams.get("token") || "";
      if (!provided || provided.length !== config.authToken.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(config.authToken))) { json(401, { error: "Authentication required" }); return; }
    }
    // Serve uploads
    if (method === "GET" && url.pathname.startsWith("/uploads/")) {
      const fn = url.pathname.replace("/uploads/", ""); if (/[^a-zA-Z0-9._-]/.test(fn)) { json(400, { error: "Invalid filename" }); return; }
      const fp = join(dataDir, "uploads", fn); if (!existsSync(fp)) { json(404, { error: "File not found" }); return; }
      const ext = fn.split(".").pop() || "", ct: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv" };
      const h: Record<string, string> = { ...corsHeaders(req), "Content-Type": ct[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
      if (ext === "svg") h["Content-Security-Policy"] = "script-src 'none'";
      res.writeHead(200, h); res.end(readFileSync(fp)); return;
    }
    // Serve videos/images from workspace
    for (const [prefix, subdir] of [["/videos/", "videos"], ["/images/", "images"]] as const) {
      if (method === "GET" && url.pathname.startsWith(prefix)) {
        const dir = resolve(config.workspace, subdir), file = resolve(dir, url.pathname.replace(prefix, "")), rel = relative(dir, file);
        if (rel.startsWith("..") || url.pathname.includes("\x00")) { json(403, { error: "Path traversal blocked" }); return; }
        if (existsSync(file)) { const ext = file.split(".").pop() || ""; const ct: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }; res.writeHead(200, { "Content-Type": ct[ext] || "application/octet-stream" }); res.end(readFileSync(file)); return; }
      }
    }
    // Serve workspace apps
    if (method === "GET" && url.pathname.startsWith("/apps/")) {
      const appsDir = resolve(config.workspace), appFile = resolve(appsDir, "." + url.pathname), rel = relative(appsDir, appFile);
      if (rel.startsWith("..")) { json(403, { error: "Path traversal blocked" }); return; }
      if (existsSync(appFile)) {
        const ext = appFile.split(".").pop() || "", ct: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
        const h: Record<string, string> = { "Content-Type": ct[ext] || "application/octet-stream" };
        if (ext === "html") {
          h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";
          h["X-Content-Type-Options"] = "nosniff"; h["X-Frame-Options"] = "DENY"; h["Referrer-Policy"] = "no-referrer"; h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()";
          let html = readFileSync(appFile, "utf-8");
          const iso = `<script>sessionStorage.removeItem('sax_token');localStorage.removeItem('sax_token');delete window.__AUTH_TOKEN__;history.replaceState(null,'',location.pathname);</script>`;
          html = html.includes("<head>") ? html.replace("<head>", "<head>" + iso) : html.includes("<body>") ? html.replace("<body>", "<body>" + iso) : iso + html;
          res.writeHead(200, h); res.end(html); return;
        }
        res.writeHead(200, h); res.end(readFileSync(appFile)); return;
      }
    }
    // Serve dashboard
    if (method === "GET") {
      const fp = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app.html" ? join(publicDir, "app.html") : join(publicDir, url.pathname);
      if (relative(publicDir, resolve(fp)).startsWith("..")) { json(403, { error: "Path traversal blocked" }); return; }
      if (existsSync(fp)) {
        const ext = fp.split(".").pop() || "", ct: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };
        const h: Record<string, string> = { "Content-Type": ct[ext] || "application/octet-stream" };
        if (ext === "html") { h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: mediastream:; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"; h["X-Content-Type-Options"] = "nosniff"; h["X-Frame-Options"] = "DENY"; h["Referrer-Policy"] = "no-referrer"; h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"; }
        res.writeHead(200, h); res.end(readFileSync(fp)); return;
      }
    }
    json(404, { error: "Not found" });
  };

  // Server + WebSocket
  const server = createServer(requestHandler);
  runMigrations(dataDir).catch(e => console.warn("[migrations]", e.message));
  const chatWs = setupChatWebSocket(server, config.authToken);

  // Event bus: primal agent execution
  const eventBus = EventBus.getInstance();
  const pendingMeta = new Map<string, { name: string; role: string; task: string; systemPrompt: string; parentAgentId: string | null; sessionId: string; startedAt: number; toolsUsed: string[] }>();

  eventBus.on("primal:agent-run", async (data: any) => {
    const { agentId, task, systemPrompt, role, parentSessionId } = data;
    console.log(`[primal] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);
    let parentContext = "";
    if (parentSessionId) { const ps = sessions.get(parentSessionId); if (ps?.messages.length) { parentContext = `\n\n--- PARENT CONTEXT ---\n${ps.messages.slice(-10).filter((m: any) => typeof m.content === "string").map((m: any) => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`).join("\n")}\n--- END ---\n`; } }
    let briefing = "";
    try { const uMd = join(dataDir, "memory", "USER.md"), mMd = join(dataDir, "memory", "MIND.md"); const u = existsSync(uMd) ? readFileSync(uMd, "utf-8").slice(0, 500) : "", m = existsSync(mMd) ? readFileSync(mMd, "utf-8").slice(0, 500) : ""; briefing = `\n\n--- BRIEFING ---\nUser: ${u || "(none)"}\nFacts: ${m || "(none)"}\nSecrets: ${secretsStore.list().map(s => s.name).join(", ") || "(none)"}\n--- END ---\n`; } catch {}
    const agentSession: Session = { id: `agent-${agentId}`, title: `Agent: ${role}`, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    try {
      const saved = loadSavedSettings();
      const { provider, apiKey, model } = await resolveProviderAndKey(saved);
      const spawnedTools = allAgentTools.filter(t => !t.name.startsWith("agent_") && !t.name.startsWith("swarm_") && t.name !== "delegate");
      const ac = new AbortController(); const to = setTimeout(() => { ac.abort(); console.warn(`[primal] Agent ${agentId} timed out`); }, 300000);
      const agentResult = await enqueue("agent", () => runAgent(task, agentSession.messages, {
        apiKey, model, provider: provider as any, systemPrompt: (systemPrompt || `You are a ${role} agent. Complete the task. STOP if login is needed or after 3 failed attempts. End with a summary.`) + parentContext + briefing,
        tools: spawnedTools, security, toolPolicy, sessionId: `agent-${agentId}`, maxIterations: config.maxIterations, temperature: config.temperature, signal: ac.signal,
        pauseCallback: async (reason: string) => { eventBus.emit("primal:agent-output", { agentId, output: `[BLOCKER] ${reason}` }); eventBus.emit("primal:agent-blocked", { agentId, reason, role }); return new Promise<string>(r => { const h = (d: any) => { if (d.agentId === agentId) { eventBus.off("primal:agent-user-input", h); r(d.message); } }; eventBus.on("primal:agent-user-input", h); setTimeout(() => { eventBus.off("primal:agent-user-input", h); r("User did not respond."); }, 300000); }); },
        onEvent: (event) => { if (event.type === "stream" && event.delta) eventBus.emit("primal:agent-output", { agentId, output: event.delta }); if (event.type === "tool_start") { console.log(`[primal] Agent ${agentId} tool: ${event.toolName}`); eventBus.emit("primal:agent-output", { agentId, output: `[tool] ${event.toolName}...` }); } if (event.type === "tool_start" && event.requiresApproval) event.requiresApproval = false; },
      }), { label: `agent:${agentId}`, timeout: 300_000 });
      clearTimeout(to); if (agentResult?.messages) agentSession.messages.push(...agentResult.messages);
      eventBus.emit("primal:agent-result", { agentId, result: extractAgentOutput(agentSession.messages), success: true });
    } catch (e) { const p = extractAgentOutput(agentSession.messages), msg = (e as Error).name === "AbortError" ? "Agent timed out" : safeErrorMessage(e); eventBus.emit("primal:agent-result", { agentId, result: p ? `[${msg}]\n\n${p}` : msg, success: false }); }
  });

  // Forward agent events to WS + persist
  eventBus.on("primal:agent-spawn", (d: any) => { broadcastAll({ type: "agent-spawn", ...d }); pendingMeta.set(d.agentId, { name: d.name, role: d.role, task: d.task, systemPrompt: d.systemPrompt || "", parentAgentId: d.parentAgentId || null, sessionId: d.parentSessionId || "", startedAt: Date.now(), toolsUsed: [] }); });
  eventBus.on("primal:agent-output", (d: any) => { broadcastAll({ type: "agent-output", ...d }); const m = pendingMeta.get(d.agentId); if (m && typeof d.output === "string" && d.output.startsWith("[tool]")) { const t = d.output.replace("[tool] ", "").replace("...", "").trim(); if (t && !m.toolsUsed.includes(t)) m.toolsUsed.push(t); } });
  eventBus.on("primal:agent-blocked", (d: any) => broadcastAll({ type: "agent-blocked", agentId: d.agentId, reason: d.reason, role: d.role }));
  eventBus.on("primal:agent-result", (d: any) => { broadcastAll({ type: "agent-complete", ...d }); const m = pendingMeta.get(d.agentId); if (m) { agentRunStore.save({ id: d.agentId, parentAgentId: m.parentAgentId, sessionId: m.sessionId, name: m.name, role: m.role, task: m.task, systemPrompt: m.systemPrompt, status: d.success === false ? "error" : "done", output: [], result: d.result || "", toolsUsed: m.toolsUsed, tokensUsed: d.tokens || 0, startedAt: m.startedAt, completedAt: Date.now(), error: d.success === false ? d.result : undefined } as AgentRun); pendingMeta.delete(d.agentId); } });
  eventBus.on("primal:agent-redirect", (d: any) => broadcastAll({ type: "agent-update", ...d, status: "redirected" }));

  // Config hot-reload
  new ConfigWatcher().start(join(dataDir, "config.json"), () => console.log("[config] Hot-reloaded"));

  // Startup
  let memBgTimer: ReturnType<typeof setInterval> | undefined;
  server.listen(config.port, "127.0.0.1", () => {
    const masked = config.authToken ? config.authToken.slice(0, 4) + "****" + config.authToken.slice(-4) : "none";
    console.log(`\n  Open Agent X running at http://127.0.0.1:${config.port}\n  Auth token: ${masked}`);
    const realUrl = `http://127.0.0.1:${config.port}/?token=${config.authToken}`;
    writeFileSync(join(dataDir, ".startup-url"), realUrl, { mode: 0o600 });
    console.log(`\n  ► Open: \x1b]8;;${realUrl}\x1b\\http://127.0.0.1:${config.port}/?token=${masked}\x1b]8;;\x1b\\\n  Memory: ${dataDir}/memory/\n  Sessions: ${dataDir}/sessions/`);
    printAuditReport(runSecurityAudit({ authToken: config.authToken, workspace: config.workspace }));
    startAriKernel(join(dataDir, "ari-audit.db"), undefined, config.ariRequired).then(a => { if (a) console.log(`  [ari] Audit active`); else if (config.ariRequired) console.error(`  [ari] CRITICAL: ARI failed`); });
    // Cron
    cronService.onExecute(async (jobId, prompt) => {
      const saved = loadSavedSettings();
      const { provider, apiKey, model } = await resolveProviderAndKey(saved);
      const session = getOrCreateSession(`cron-${jobId}`);
      const cronSecurity = new SecurityLayer(resolve(process.env.SAX_WORKSPACE || join(homedir(), ".sax", "workspace")), "workspace");
      const result = await runAgent(prompt, session.messages, { apiKey, model: provider === "anthropic" ? "claude-haiku-4-5" : model, provider: provider as any, systemPrompt: config.systemPrompt, tools: allAgentTools, security: cronSecurity, toolPolicy, sessionId: `cron-${jobId}`, maxIterations: config.maxIterations });
      session.messages = result.messages.filter(m => m.role !== "system"); session.updatedAt = Date.now(); saveSession(session);
      return result.messages.filter(m => m.role === "assistant" && m.content).map(m => String(m.content)).join("\n").slice(0, 500) || "Completed";
    });
    cronService.start();
    // Memory background (every 6h + 30s after startup)
    const runMemBg = async () => {
      try { const { MemoryOrchestrator: MO } = await import("./memory-orchestrator.js"); const r = MO.getInstance().runBackground(memoryIndex); console.log(`[memory-bg] ${r.totalTimeMs}ms`); } catch (e) { console.warn("[memory-bg]", (e as Error).message); }
      try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000, stale = sessionStore.list().filter(s => s.updatedAt < cutoff && s.messageCount > 4);
        const dir = join(dataDir, "memory", "session-summaries"); mkdirSync(dir, { recursive: true }); let n = 0;
        for (const meta of stale.slice(0, 20)) { const sf = join(dir, `${meta.id}.md`); if (existsSync(sf)) continue; const sess = sessionStore.load(meta.id); if (!sess) continue; writeFileSync(sf, `# ${sess.title}\n\n${new Date(sess.createdAt).toISOString().split("T")[0]} | ${sess.messages.length} messages`, "utf-8"); n++; }
        if (n > 0) console.log(`[memory-bg] Summarized ${n} stale sessions`);
      } catch (e) { console.warn("[memory-bg] Summarization:", (e as Error).message); }
    };
    memBgTimer = setInterval(runMemBg, 6 * 60 * 60 * 1000);
    setTimeout(runMemBg, 30_000);
    // Sync
    const syncCfg = agentSync.getConfig();
    if (syncCfg.enabled && syncCfg.autoDownload) agentSync.pull().then(r => { if (r.success) console.log(`[sync] Startup pull: ${r.message}`); }).catch(() => {});
    agentSync.startHeartbeat();
  });

  process.on("SIGINT", async () => { clearInterval(memBgTimer); agentSync.stopHeartbeat(); await agentSync.push().catch(() => {}); await closeAllBrowsers(); memoryIndex.close(); secretsStore.destroy(); process.exit(0); });
  return server;
}
