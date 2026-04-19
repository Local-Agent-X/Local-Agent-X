import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { runAgent, type AgentOptions } from "./agent.js";
import { stripEphemeralMessages } from "./agent-providers.js";
import { allTools, createHttpRequestTool, buildToolRegistry } from "./tools.js";
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
import { createCoreProtocolTools } from "./protocols.js";
import { createAllProtocolTools } from "./protocols/index.js";
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
import { createAgencyTools } from "./agency/index.js";
import { createHandlerTools } from "./agency/handler.js";
import { createSqlTools } from "./sql-tools.js";
import { createEmailTools } from "./email-tools.js";
import { createCalendarTools } from "./calendar-tools.js";
import { createSpreadsheetTools } from "./spreadsheet-tools.js";
import { createPdfTools } from "./pdf-tools.js";
import { createClipboardTools } from "./clipboard-tools.js";
import type { SAXConfig, ServerEvent, Session } from "./types.js";
import type { ServerContext } from "./server-context.js";
import { parseMultipart, extractAgentOutput, safeErrorMessage, jsonResponse, corsHeaders, isLoopbackOrigin, checkRateLimit, getRateLimitKey, recordAuthFailure, getAuthFloodGuard, setServerPort } from "./server-utils.js";
import { handleSessionRoutes, handleSecurityRoutes, handleMemoryRoutes, handleAgentRoutes, handleAppRoutes, handleSettingsRoutes, handleBridgeRoutes, handleChatRoutes } from "./routes/index.js";

export async function startServer(config: SAXConfig) {
  setServerPort(String(config.port || 7007));
  const security = new SecurityLayer(config.workspace);
  // Initialize hook engine with security layer so hook commands go through the same checks
  import("./hooks/hook-engine.js").then(({ initHookEngine }) => initHookEngine(security)).catch(() => {});
  // Initialize skill registry with workspace path so workspace skills are discovered
  import("./skills/skill-loader.js").then(({ getSkillRegistry }) => getSkillRegistry(config.workspace)).catch(() => {});
  const publicDir = join(import.meta.dirname || ".", "..", "public");
  const dataDir = join(homedir(), ".sax");
  for (const d of ["apps", "images", "videos", "missions"]) mkdirSync(join(resolve(config.workspace), d), { recursive: true });
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);
  setBrowserAuthContext(config.authToken, String(config.port));

  // Services
  const agentSync = new AgentSync(dataDir, () => secretsStore.get("GITHUB_SYNC_TOKEN"));
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  ensurePersonalityFiles(join(dataDir, "memory"));
  const secretsStore = new SecretsStore(dataDir);

  // Wire up embedding provider for semantic memory search (must complete before creating memory tools)
  try {
    const { createEmbeddingProvider } = await import("./embedding-providers.js");
    const sp = join(dataDir, "settings.json");
    const settings = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf-8")) : {};
    const embProvider = settings.embeddingProvider || "ollama";
    const embModel = settings.embeddingModel || undefined;

    // Auto-pull Ollama embedding model if Ollama is running but model not installed.
    // mxbai-embed-large (1.3GB) scored 97.0% R@5 on LongMemEval — best zero-cost score.
    // Falls back to nomic-embed-text (137MB) if mxbai pull fails, then to keyword-only search.
    if (embProvider === "ollama") {
      const targetModel = embModel || "mxbai-embed-large";
      const fallbackModel = "nomic-embed-text";
      try {
        const ollamaUrl = (settings.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
        // Check if Ollama is reachable
        const ping = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (ping?.ok) {
          const tags = await ping.json() as { models?: Array<{ name: string }> };
          const installed = (tags.models || []).map(m => m.name.replace(/:latest$/, ""));
          if (!installed.includes(targetModel)) {
            console.log(`[memory] Model "${targetModel}" not found in Ollama. Pulling... (this may take a minute on first run)`);
            try {
              const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: targetModel, stream: false }),
                signal: AbortSignal.timeout(300_000), // 5 min for large models
              });
              if (pullRes.ok) {
                console.log(`[memory] Pulled ${targetModel} successfully`);
              } else {
                console.warn(`[memory] Failed to pull ${targetModel} — trying ${fallbackModel}`);
                if (!installed.includes(fallbackModel)) {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  console.log(`[memory] Pulled ${fallbackModel} as fallback`);
                }
              }
            } catch (pullErr) {
              console.warn(`[memory] Model pull failed: ${(pullErr as Error).message}`);
              // Try fallback
              if (!installed.includes(fallbackModel)) {
                try {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  console.log(`[memory] Pulled ${fallbackModel} as fallback`);
                } catch {}
              }
            }
          }
        }
      } catch (ollamaErr) {
        console.warn(`[memory] Ollama check failed: ${(ollamaErr as Error).message}`);
      }
    }

    let apiKey: string | undefined;
    if (embProvider === "openai") apiKey = secretsStore.get("OPENAI_API_KEY") || config.openaiApiKey;
    else if (embProvider === "gemini") apiKey = secretsStore.get("GEMINI_API_KEY");
    const provider = createEmbeddingProvider({ provider: embProvider, apiKey, model: embModel });
    memoryIndex.setEmbeddingProvider(provider);
    console.log(`[memory] Embedding provider: ${provider.name}/${provider.model} (${provider.dimensions}d)`);
  } catch (e) { console.warn(`[memory] Embedding provider not available: ${(e as Error).message} — keyword search only`); }
  const memoryTools = createMemoryTools(memoryIndex);

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

  // Bridge message handler (shared by WhatsApp & Telegram)
  async function bridgeMessageHandler(platform: string, { from, name, text, sessionId }: { from: string; name: string; text: string; sessionId: string }): Promise<string> {
    const channelType = platform.toLowerCase() as ChannelType;
    const route = resolveSession(channelType, from, sessionId);

    // /reset, /clear, /new — wipe this bridge chat's session history (in-memory + on disk).
    // Useful when the session gets stuck in a broken state (empty responses, loop noise).
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "/reset" || trimmed === "/clear" || trimmed === "/new") {
      try {
        sessions.delete(route.sessionKey);
        sessionStore.delete(route.sessionKey);
        return "Fresh start. Conversation history cleared.";
      } catch (e) {
        return `Reset failed: ${(e as Error).message}`;
      }
    }

    const session = getOrCreateSession(route.sessionKey);
    if (session.messages.length === 0) session.title = `${platform}: ${name}`;
    const injectionScore = detectInjection(text).reduce((max, h) => Math.max(max, h.score), 0);
    if (injectionScore >= 0.85) return `I can't process that message — it was flagged by security filters.`;

    const { prepareAgentRequest } = await import("./agent-request.js");
    const channelConfig = getChannelConfig(channelType);
    const bridgeCtx = `\n\n[${platform} bridge] ${buildChannelContext(route)}. Message from ${name} (${from}). ` +
      `Keep responses concise — max ~${channelConfig.maxTextLength === Infinity ? "unlimited" : channelConfig.maxTextLength} chars. ` +
      (channelConfig.markdownFlavor === "plain" ? "Use plain text only. " : channelConfig.markdownFlavor === "whatsapp" ? "Use minimal formatting. " : "");
    const prepared = await prepareAgentRequest({
      channel: channelType as "telegram" | "whatsapp",
      message: text, sessionMessages: session.messages, sessionId: route.sessionKey,
      config, dataDir, memoryIndex, integrations, secretsStore,
      allAgentTools, bridgeTools, skipMemory: true, maxHistory: 30,
      bridgeContext: bridgeCtx,
    });

    const result = await enqueue("main", () => runAgent(text, prepared.cleanHistory, {
      apiKey: prepared.apiKey, model: prepared.model,
      provider: prepared.provider as AgentOptions["provider"],
      systemPrompt: prepared.systemPrompt, tools: prepared.tools,
      security, toolPolicy, rbac, callerRole: "user" as const,
      sessionId: route.sessionKey, maxIterations: prepared.maxIterations,
      temperature: prepared.temperature,
    }), { label: `bridge:${platform}:${from}` });

    session.messages = stripEphemeralMessages(result.messages).filter(m => {
      if (m.role === "system") return false;
      if (m.role === "tool") return true; // never drop tool results
      return m.content || (m as unknown as Record<string, unknown>).tool_calls;
    });
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
  const { createOperationTools } = await import("./operations/tools.js");
  const operationTools = createOperationTools();
  // Build tool registry for deferred loading
  const { registry: toolRegistry } = buildToolRegistry();

  const allAgentTools = [
    ...allTools, httpRequestTool,
    ...memoryTools, ...secretTools, ...browserTools, ...imageTools,
    ...createCoreProtocolTools(), ...createCronTools(cronService),
    ...createAgencyTools(), ...createHandlerTools(), ...appTools, ...issueTools,
    ...operationTools,
  ];
  const bridgeTools = [...allTools, ...memoryTools, ...browserTools, ...imageTools, ...createCoreProtocolTools(), ...issueTools];

  // Connect MCP servers and add their tools
  try {
    const { MCPManager } = await import("./mcp-client.js");
    const mcpManager = MCPManager.getInstance(dataDir);
    await mcpManager.connectAll();
    const mcpTools = mcpManager.getAllTools();
    if (mcpTools.length > 0) {
      allAgentTools.push(...mcpTools);
      console.log(`[mcp] Added ${mcpTools.length} tools from MCP servers`);
    }
    // Clean up MCP servers on shutdown
    process.on("SIGINT", () => { mcpManager.disconnectAll(); });
  } catch (e) {
    console.warn(`[mcp] MCP client init failed: ${(e as Error).message}`);
  }

  // Register extra tools and detect duplicates
  const seenTools = new Set<string>();
  for (const tool of allAgentTools) {
    if (seenTools.has(tool.name)) {
      console.warn(`[tools] Duplicate tool name: "${tool.name}" — later definition wins`);
    }
    seenTools.add(tool.name);
    if (!toolRegistry.get(tool.name)) {
      toolRegistry.register(tool, { defer: true, tags: [], searchHint: tool.description.slice(0, 80) });
    }
  }

  // Session management
  const MAX_CACHED = config.maxCachedSessions;
  const sessions = new Map<string, Session>();
  function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (s) { sessions.delete(id); sessions.set(id, s); return s; }
    s = sessionStore.load(id) ?? undefined;
    if (s) { sessions.set(id, s); if (sessions.size > MAX_CACHED) sessions.delete(sessions.keys().next().value!); return s; }
    s = { id, title: "New Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(id, s); if (sessions.size > MAX_CACHED) sessions.delete(sessions.keys().next().value!); return s;
  }
  const writeQueues = new Map<string, Promise<void>>();
  // Track how many Q+A pairs have been indexed per session
  const sessionIndexedPairs = new Map<string, number>();

  function saveSession(session: Session): void {
    const prev = writeQueues.get(session.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      sessions.set(session.id, session);
      sessionStore.save(session);
      memoryIndex.markDirty();
      // Incrementally index new conversation pairs for immediate memory search
      try { await indexSessionIncrementally(session); } catch (e) { console.warn(`[memory] Incremental index failed:`, (e as Error).message); }
    }).catch(e => console.error(`[session] Save failed:`, e));
    writeQueues.set(session.id, next);
    next.finally(() => { if (writeQueues.get(session.id) === next) writeQueues.delete(session.id); });
  }

  async function indexSessionIncrementally(session: Session): Promise<void> {
    // Skip system sessions (dream, ingest, etc.)
    if (session.id.startsWith("dream-") || session.id.startsWith("ide-")) return;
    console.log(`[memory-live] Indexing session ${session.id} (${session.messages?.length || 0} messages)`);
    const { extractSessionPairs, chunkConversationPairs } = await import("./memory-chunking.js");
    const messages = extractSessionPairs(join(dataDir, "sessions", session.id + ".json"));
    if (messages.length < 2) return;

    // Build Q+A pairs from messages
    const pairs: Array<{ user: string; assistant: string }> = [];
    let i = 0;
    while (i < messages.length) {
      if (messages[i].role === "user") {
        const userContent = messages[i].content;
        let assistantContent = "";
        i++;
        while (i < messages.length && messages[i].role === "assistant") {
          assistantContent += (assistantContent ? "\n\n" : "") + messages[i].content;
          i++;
        }
        if (assistantContent) pairs.push({ user: userContent, assistant: assistantContent });
      } else { i++; }
    }

    const alreadyIndexed = sessionIndexedPairs.get(session.id) || 0;
    if (pairs.length <= alreadyIndexed) return; // Nothing new

    // Only chunk the NEW pairs
    const newPairs = pairs.slice(alreadyIndexed);
    const newMessages = newPairs.flatMap(p => [
      { role: "user" as const, content: p.user },
      { role: "assistant" as const, content: p.assistant },
    ]);

    const sessionDate = session.createdAt ? new Date(session.createdAt).toISOString().split("T")[0] : undefined;
    const metadata = { source_type: "agent-x-session" as const, session_id: session.id, date: sessionDate };
    const virtualPath = `session-live/${session.id}/${pairs.length}`;
    const chunks = chunkConversationPairs(newMessages, virtualPath, "sessions", metadata);

    if (chunks.length > 0) {
      await memoryIndex.indexChunks(chunks, virtualPath, "sessions");
      sessionIndexedPairs.set(session.id, pairs.length);
      console.log(`[memory-live] Indexed ${chunks.length} new chunks from ${newPairs.length} pairs (session ${session.id}, total pairs: ${pairs.length})`);
    } else {
      console.log(`[memory-live] No new pairs to index for ${session.id}`);
    }
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
      allAgentTools, toolRegistry, bridgeTools, getOrCreateSession, saveSession, chatWs, broadcastAll,
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
      for await (const chunk of req) { totalSize += (chunk as Buffer).length; if (totalSize > config.maxUploadBytes) { json(413, { error: `File too large. Max ${Math.round(config.maxUploadBytes / 1048576)}MB.` }); req.destroy(); return; } chunks.push(chunk as Buffer); }
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
    // Static auth for /uploads/, /videos/, /images/, /files/
    if (method === "GET" && ["/uploads/", "/videos/", "/images/", "/files/"].some(r => url.pathname.startsWith(r))) {
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
    // Serve workspace files (documents, exports, downloads)
    if (method === "GET" && url.pathname.startsWith("/files/")) {
      const filePath = decodeURIComponent(url.pathname.slice(7)); // strip "/files/"
      const wsDir = resolve(config.workspace);
      const file = resolve(wsDir, filePath), rel = relative(wsDir, file);
      if (rel.startsWith("..") || filePath.includes("\x00")) { json(403, { error: "Path traversal blocked" }); return; }
      if (!existsSync(file)) { json(404, { error: "File not found" }); return; }
      const ext = (file.split(".").pop() || "").toLowerCase();
      const ct: Record<string, string> = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv", md: "text/markdown", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", html: "text/html", css: "text/css", js: "application/javascript" };
      const inlineable = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "json", "csv", "md", "html", "css", "js", "mp4", "webm"]);
      const filename = file.split(/[/\\]/).pop() || "download";
      const h: Record<string, string> = { ...corsHeaders(req), "Content-Type": ct[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" };
      if (!inlineable.has(ext)) h["Content-Disposition"] = `attachment; filename="${filename}"`;
      if (ext === "svg") h["Content-Security-Policy"] = "script-src 'none'";
      res.writeHead(200, h); res.end(readFileSync(file)); return;
    }
    // Serve workspace apps
    if (method === "GET" && url.pathname.startsWith("/apps/")) {
      const appsDir = resolve(config.workspace), appFile = resolve(appsDir, "." + url.pathname), rel = relative(appsDir, appFile);
      if (rel.startsWith("..")) { json(403, { error: "Path traversal blocked" }); return; }
      if (existsSync(appFile)) {
        const ext = appFile.split(".").pop() || "", ct: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
        const h: Record<string, string> = { "Content-Type": ct[ext] || "application/octet-stream" };
        if (ext === "html") {
          h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'";
          h["X-Content-Type-Options"] = "nosniff"; h["X-Frame-Options"] = "SAMEORIGIN"; h["Referrer-Policy"] = "no-referrer"; h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()";
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
        if (ext === "html") { h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: mediastream:; frame-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"; h["X-Content-Type-Options"] = "nosniff"; h["X-Frame-Options"] = "SAMEORIGIN"; h["Referrer-Policy"] = "no-referrer"; h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()"; }
        res.writeHead(200, h); res.end(readFileSync(fp)); return;
      }
    }
    json(404, { error: "Not found" });
  };

  // Server + WebSocket
  const server = createServer(requestHandler);
  runMigrations(dataDir).catch(e => console.warn("[migrations]", e.message));
  const chatWs = setupChatWebSocket(server, config.authToken);

  // Register WS chat handler — triggers the same chat pipeline as HTTP
  chatWs.onChat(async (sessionId, message, attachments) => {
    try {
      // Make an internal fetch to the chat endpoint — reuses all the same logic
      const body = JSON.stringify({ message, sessionId, attachments: attachments || [] });
      const res = await fetch(`http://127.0.0.1:${config.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.authToken}` },
        body,
        signal: AbortSignal.timeout(600_000),
      });
      // Consume the SSE response (events already flow via WS broadcastToSession)
      if (res.body) { for await (const _ of res.body) { /* drain */ } }
    } catch (e) {
      console.warn(`[ws-chat] Error:`, (e as Error).message);
    }
  });

  // Event bus: handler agent execution
  const eventBus = EventBus.getInstance();
  const pendingMeta = new Map<string, { name: string; role: string; task: string; systemPrompt: string; parentAgentId: string | null; sessionId: string; startedAt: number; toolsUsed: string[] }>();

  // Event payload types for handler agent system
  interface AgentRunEvent { agentId: string; task: string; systemPrompt: string; role: string; parentSessionId?: string; templateId?: string }
  interface AgentSpawnEvent { agentId: string; name: string; role: string; task: string; systemPrompt?: string; parentAgentId?: string; parentSessionId?: string }
  interface AgentOutputEvent { agentId: string; output: string }
  interface AgentBlockedEvent { agentId: string; reason: string; role: string }
  interface AgentResultEvent { agentId: string; result: string; success: boolean; tokens?: number }
  interface AgentUserInputEvent { agentId: string; message: string }
  interface AgentRedirectEvent { agentId: string; [key: string]: unknown }

  eventBus.on("handler:agent-run", async (data: unknown) => {
    const { agentId, task, systemPrompt, role, parentSessionId } = data as AgentRunEvent;
    const templateId = (data as AgentRunEvent).templateId;
    console.log(`[handler] Agent ${agentId} (${role}) starting: ${task.slice(0, 80)}...`);

    // Resolve template for identity + tool restrictions
    const template = templateId ? agentTemplateStore.get(templateId) : null;
    const projectStore = ProjectStore.getInstance();
    const agentProject = template ? projectStore.getAgentProject(template.id) : null;

    let parentContext = "";
    if (parentSessionId) { const ps = sessions.get(parentSessionId); if (ps?.messages.length) { parentContext = `\n\n--- PARENT CONTEXT ---\n${ps.messages.slice(-10).filter(m => typeof m.content === "string").map(m => `${m.role === "user" ? "User" : "Agent"}: ${(m.content as string).slice(0, 200)}`).join("\n")}\n--- END ---\n`; } }
    let briefing = "";
    try { const uMd = join(dataDir, "memory", "USER.md"), mMd = join(dataDir, "memory", "MIND.md"); const u = existsSync(uMd) ? readFileSync(uMd, "utf-8").slice(0, 500) : "", m = existsSync(mMd) ? readFileSync(mMd, "utf-8").slice(0, 500) : ""; briefing = `\n\n--- BRIEFING ---\nUser: ${u || "(none)"}\nFacts: ${m || "(none)"}\nSecrets: ${secretsStore.list().map(s => s.name).join(", ") || "(none)"}\n--- END ---\n`; } catch {}

    // Build identity block so agent knows who it is
    const identityBlock = template
      ? `\n\n--- YOUR IDENTITY ---\nAgent ID: ${template.id}\nName: ${template.name}\nRole: ${template.role}\n${template.reportsTo ? `Reports to: ${template.reportsTo}` : "Reports to: Board (user)"}\n${agentProject ? `Project: ${agentProject.name}` : ""}\nUse agent_whoami with agentId="${template.id}" to see your full status and assigned issues.\n--- END IDENTITY ---\n`
      : `\n\nYour agent ID: ${agentId}\n`;

    const agentSession: Session = { id: `agent-${agentId}`, title: `Agent: ${role}`, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    let worktreeInfo: { path: string; branch: string } | null = null;
    try {
      const { resolveProvider } = await import("./agent-request.js");
      const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);

      // Build tool list: respect template.allowedTools if set, otherwise give role-appropriate tools
      // Agents now GET issue_* and agent_* tools (they're real employees, not disposable workers)
      const CORE_AGENT_TOOLS = new Set(["read", "write", "edit", "bash", "glob", "grep", "web_fetch", "web_search", "view_image", "ask_user",
        "http_request", "ocr", "memory_search", "memory_save", "memory_recall", "memory_update_profile",
        "document_create", "document_edit", "spreadsheet_write", "spreadsheet_read", "pdf_create",
        "mission_schedule_list", "mission_schedule_reports",
        "issue_create", "issue_list", "issue_update", "issue_search", "issue_checkout", "issue_release", "issue_request_approval",
        "agent_whoami", "agent_team_list", "agent_wakeup", "task_create", "task_update", "task_list", "task_get"]);
      let spawnedTools = allAgentTools.filter(t => CORE_AGENT_TOOLS.has(t.name));
      if (template?.allowedTools && template.allowedTools.length > 0) {
        // Template restricts tools — enforce it. Always include issue_* and agent_* for coordination.
        const allowed = new Set([...template.allowedTools, "issue_create", "issue_list", "issue_update", "issue_search", "issue_checkout", "issue_release", "issue_request_approval", "agent_whoami", "agent_team_list", "agent_wakeup"]);
        spawnedTools = spawnedTools.filter(t => allowed.has(t.name));
      }

      // Create isolated worktree for all delegated agents (all providers including Codex)
      let worktreeBlock = "";
      try {
        const { createWorktree } = await import("./agency/worktree.js");
        worktreeInfo = createWorktree(agentId);
        if (worktreeInfo) {
          security.addAllowedPath(worktreeInfo.path, `agent-${agentId}`);
          worktreeBlock = `\n\n--- WORKTREE ---\nYou are working in an isolated git worktree at: ${worktreeInfo.path}\nFor code changes: cd to this directory before running bash commands.\nFor OUTPUT FILES (reports, summaries, exports): ALWAYS write to ${resolve(config.workspace)}/ — the worktree gets cleaned up so files written there will be DELETED.\n--- END WORKTREE ---\n`;
        }
      } catch { /* not a git repo or git not available */ }

      // If no worktree, strip mutation tools — agent can only read/search, not write code
      if (!worktreeInfo) {
        const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
        const before = spawnedTools.length;
        spawnedTools = spawnedTools.filter(t => !MUTATION_TOOLS.has(t.name));
        if (spawnedTools.length < before) {
          console.warn(`[handler] Agent ${agentId}: no worktree — removed write/edit/bash (read-only mode)`);
          worktreeBlock = `\n\n--- READ-ONLY MODE ---\nNo worktree available. You can read/search files and use web tools, but cannot write files or run bash commands. Write output to workspace/ using document_create or other workspace tools.\n--- END ---\n`;
        }
      }

      console.log(`[handler] Agent ${agentId} using ${provider}/${model} with ${spawnedTools.length} tools${worktreeInfo ? ` (worktree: ${worktreeInfo.path})` : " (read-only)"}`);
      const ac = new AbortController(); const to = setTimeout(() => { ac.abort(); console.warn(`[handler] Agent ${agentId} timed out`); }, config.agentTimeoutMs);
      const agentResult = await enqueue("agent", () => runAgent(task, agentSession.messages, {
        apiKey, model, provider: provider as AgentOptions["provider"], systemPrompt: (systemPrompt || `You are a ${role} agent. Complete the task. STOP if login is needed or after 3 failed attempts. End with a summary.`) + `\n\nEXECUTION RULES:\n- Platform: ${process.platform === "win32" ? "Windows. The bash tool runs PowerShell. Use PowerShell commands (Get-ChildItem, Select-Object, etc.) not Unix commands. Use Windows paths (C:\\Users\\...) not Unix paths (/mnt/c/...)." : "Linux/macOS. The bash tool runs /bin/bash."}\n- STRATEGY: List first, then peek, then act. Never start by reading a huge file — check its size, look at the first few lines, understand the structure, THEN process.\n- For large files (>1MB): use python -c to extract what you need in ONE command. Never use the read tool on large files.\n- For JSON: use python -c "import json; d=json.load(open('file.json')); print(len(d), type(d))" to understand structure first.\n- Bash commands time out at 120s. If something might take longer, break it into steps.\n- If a command fails, try a DIFFERENT approach. Don't repeat.\n- Save results to workspace/ as you go.\n- You have ~25 tool calls max. Each one should do real work.\n` + identityBlock + parentContext + briefing + worktreeBlock,
        tools: spawnedTools, security, toolPolicy, sessionId: `agent-${agentId}`, maxIterations: config.maxIterations, temperature: config.temperature, signal: ac.signal,
        pauseCallback: async (reason: string) => { eventBus.emit("handler:agent-output", { agentId, output: `[BLOCKER] ${reason}` }); eventBus.emit("handler:agent-blocked", { agentId, reason, role }); return new Promise<string>(r => { const h = (d: unknown) => { const evt = d as AgentUserInputEvent; if (evt.agentId === agentId) { eventBus.off("handler:agent-user-input", h); r(evt.message); } }; eventBus.on("handler:agent-user-input", h); setTimeout(() => { eventBus.off("handler:agent-user-input", h); r("User did not respond."); }, config.agentTimeoutMs); }); },
        onEvent: (event) => { if (event.type === "stream" && event.delta) eventBus.emit("handler:agent-output", { agentId, output: event.delta }); if (event.type === "tool_start") { console.log(`[handler] Agent ${agentId} tool: ${event.toolName}`); eventBus.emit("handler:agent-output", { agentId, output: `[tool] ${event.toolName}...` }); } if (event.type === "tool_progress") { eventBus.emit("handler:agent-output", { agentId, output: `[progress] ${event.message}` }); } if (event.type === "tool_start" && event.requiresApproval) event.requiresApproval = false; },
      }), { label: `agent:${agentId}`, timeout: config.agentTimeoutMs });
      clearTimeout(to); if (agentResult?.messages) agentSession.messages.push(...agentResult.messages);

      // Merge worktree changes back and revoke path access
      let mergeSuccess = true;
      if (worktreeInfo) {
        security.removeAllowedPath(worktreeInfo.path, `agent-${agentId}`);
        try {
          const { mergeWorktree } = await import("./agency/worktree.js");
          const mergeResult = mergeWorktree(agentId);
          const mergeMsg = mergeResult.merged
            ? (mergeResult.files > 0 ? `[Merged ${mergeResult.files} files back to main]` : "[No file changes]")
            : `[Merge failed: ${mergeResult.error}]`;
          eventBus.emit("handler:agent-output", { agentId, output: mergeMsg });
          if (!mergeResult.merged && mergeResult.files > 0) mergeSuccess = false;
        } catch (e) { console.warn(`[worktree] Merge error: ${(e as Error).message}`); mergeSuccess = false; }
      }

      const agentOutput = extractAgentOutput(agentSession.messages);
      if (mergeSuccess) {
        eventBus.emit("handler:agent-result", { agentId, result: agentOutput, success: true });
      } else {
        // Merge conflict: changes preserved on agent branch — tell user where to find them
        const branchHint = worktreeInfo ? `Changes preserved on branch agent/${agentId}. Run: git merge agent/${agentId}` : "File changes may be lost";
        eventBus.emit("handler:agent-result", { agentId, result: `[Agent completed but merge had conflicts — ${branchHint}]\n\n${agentOutput}`, success: false });
      }
    } catch (e) {
      // Cleanup worktree on failure + revoke path access
      if (worktreeInfo) security.removeAllowedPath(worktreeInfo.path, `agent-${agentId}`);
      try { const { cleanupWorktree } = await import("./agency/worktree.js"); cleanupWorktree(agentId); } catch {}
      const p = extractAgentOutput(agentSession.messages), msg = (e as Error).name === "AbortError" ? "Agent timed out" : safeErrorMessage(e); eventBus.emit("handler:agent-result", { agentId, result: p ? `[${msg}]\n\n${p}` : msg, success: false });
    }
  });

  // Forward agent events to WS + persist
  eventBus.on("handler:agent-spawn", (d: unknown) => { const evt = d as AgentSpawnEvent; broadcastAll({ type: "agent-spawn", ...evt }); pendingMeta.set(evt.agentId, { name: evt.name, role: evt.role, task: evt.task, systemPrompt: evt.systemPrompt || "", parentAgentId: evt.parentAgentId || null, sessionId: evt.parentSessionId || "", startedAt: Date.now(), toolsUsed: [] }); });
  eventBus.on("handler:agent-output", (d: unknown) => { const evt = d as AgentOutputEvent; broadcastAll({ type: "agent-output", ...evt }); const m = pendingMeta.get(evt.agentId); if (m && typeof evt.output === "string" && evt.output.startsWith("[tool]")) { const t = evt.output.replace("[tool] ", "").replace("...", "").trim(); if (t && !m.toolsUsed.includes(t)) m.toolsUsed.push(t); } });
  eventBus.on("handler:agent-blocked", (d: unknown) => { const evt = d as AgentBlockedEvent; broadcastAll({ type: "agent-blocked", agentId: evt.agentId, reason: evt.reason, role: evt.role }); });
  eventBus.on("handler:agent-result", (d: unknown) => {
    const evt = d as AgentResultEvent;
    broadcastAll({ type: "agent-complete", ...evt });
    const m = pendingMeta.get(evt.agentId);
    if (m) {
      agentRunStore.save({ id: evt.agentId, parentAgentId: m.parentAgentId, sessionId: m.sessionId, name: m.name, role: m.role, task: m.task, systemPrompt: m.systemPrompt, status: evt.success === false ? "error" : "done", output: [], result: evt.result || "", toolsUsed: m.toolsUsed, tokensUsed: evt.tokens || 0, startedAt: m.startedAt, completedAt: Date.now(), error: evt.success === false ? evt.result : undefined } as AgentRun);
      // Append agent result to the parent chat session so it persists
      if (m.sessionId && evt.result) {
        try {
          const parentSession = sessionStore.load(m.sessionId);
          if (parentSession) {
            const label = evt.success === false ? `Agent ${m.name} failed` : `Agent ${m.name} completed`;
            parentSession.messages.push({ role: "assistant", content: `**${label}:**\n\n${evt.result}` } as any);
            parentSession.updatedAt = Date.now();
            sessionStore.save(parentSession);
          }
        } catch {}
      }
      pendingMeta.delete(evt.agentId);
    }
  });
  eventBus.on("handler:agent-redirect", (d: unknown) => { const evt = d as AgentRedirectEvent; broadcastAll({ type: "agent-update", ...evt, status: "redirected" }); });

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
    const cronReportsDir = join(dataDir, "cron", "reports");
    if (!existsSync(cronReportsDir)) mkdirSync(cronReportsDir, { recursive: true });
    cronService.onExecute(async (jobId, prompt) => {
      const cronSecurity = new SecurityLayer(resolve(process.env.SAX_WORKSPACE || join(homedir(), ".sax", "workspace")), "workspace");
      const sessionId = `cron-${jobId}-${Date.now()}`;
      try {
        const { Handler } = await import("./agency/handler.js");
        Handler.getInstance().currentSessionId = sessionId;
      } catch {}
      const { prepareAgentRequest } = await import("./agent-request.js");
      const prepared = await prepareAgentRequest({
        channel: "cron", message: prompt, sessionMessages: [], sessionId,
        config, dataDir, memoryIndex, integrations, secretsStore,
        allAgentTools, bridgeTools, skipMemory: true,
      });
      const cronModel = prepared.provider === "anthropic" ? "claude-haiku-4-5" : prepared.model;
      // Cron jobs use a minimal system prompt focused on the task — NOT the full agent prompt
      // which contains rules about Instagram, agents, memory saving that confuse the model
      const cronSystemPrompt = `You are a focused task execution agent. Your ONLY job is to complete the task described below. Do not list protocols, do not search memories unless the task requires it, do not do anything other than what is asked. Use the tools available to complete the task thoroughly and return the results.\n\nTask:\n${prompt}`;
      const result = await runAgent(prompt, [], { apiKey: prepared.apiKey, model: cronModel, provider: prepared.provider as AgentOptions["provider"], systemPrompt: cronSystemPrompt, tools: prepared.tools, security: cronSecurity, toolPolicy, sessionId, maxIterations: config.maxIterations });
      // Save the session for history
      const session = getOrCreateSession(sessionId);
      session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system"); session.updatedAt = Date.now(); saveSession(session);
      // Extract output — include sub-agent results if the parent delegated
      let output = extractAgentOutput(result.messages);
      try {
        const { Handler } = await import("./agency/handler.js");
        const handler = Handler.getInstance();
        const subResults = await handler.waitForSessionAgents(sessionId, 300_000);
        if (subResults.length > 0) {
          const subOutput = subResults.join("\n\n---\n\n");
          output = subOutput.length > output.length ? subOutput : output + "\n\n---\n\n" + subOutput;
          console.log(`[cron] Job ${jobId}: collected ${subResults.length} sub-agent result(s)`);
        }
      } catch (e) { console.warn(`[cron] Sub-agent wait error:`, (e as Error).message); }
      if (!output) {
        console.error(`[cron] Job ${jobId} produced no output (stopReason: ${result.stopReason})`);
        return { output: "ERROR: Agent produced no output — check provider/model config" };
      }
      // Save full report to file
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const jobDir = join(cronReportsDir, jobId);
      if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });
      const reportPath = join(jobDir, `${ts}.md`);
      const job = cronService.get(jobId);
      const reportContent = `# ${job?.name || jobId} — ${new Date().toLocaleDateString()}\n\n${output}`;
      writeFileSync(reportPath, reportContent, "utf-8");
      // Also save to workspace/missions/{slug}/ so agents can find reports easily
      const slug = (job?.name || jobId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const missionDir = join(resolve(config.workspace), "missions", slug);
      mkdirSync(missionDir, { recursive: true });
      const wsCopy = join(missionDir, `${ts}.md`);
      writeFileSync(wsCopy, reportContent, "utf-8");
      // Also keep a latest.md symlink-style copy for quick access
      writeFileSync(join(missionDir, "latest.md"), reportContent, "utf-8");
      console.log(`[cron] Report saved: ${reportPath} + ${wsCopy}`);
      return { output: output.slice(0, 500), reportPath };
    });
    cronService.start();

    // Wire up worker sessions — persistent agents scoped to a working directory
    // Used by build_app for app editing with the user's chosen provider/model
    import("./worker-session.js").then(({ registerWorkerRunner }) => {
      registerWorkerRunner(async (workerSession, message) => {
        const { resolveProvider } = await import("./agent-request.js");
        const sessionId = workerSession.id;
        const { provider, apiKey, model } = await resolveProvider(config, secretsStore, dataDir);

        const workerPrompt = `You are a focused app builder. Your working directory is: ${workerSession.workingDir}

Your job: build or edit the app as instructed. Write complete, working code.

Rules:
- Use the write tool to create new files (use absolute paths in ${workerSession.workingDir}/)
- Use edit for targeted changes to existing files
- The main entry point MUST be index.html
- For single-page apps: inline CSS and JS in index.html is fine
- Make it polished — modern CSS, good colors, responsive design
- If using images from the web, use full URLs (https://)
- Do NOT ask questions — just build it
- When done, confirm what you created/changed`;
        const workerTools = allAgentTools.filter(t =>
          ["read", "write", "edit", "bash", "glob", "grep", "web_fetch", "web_search", "view_image"].includes(t.name)
        );
        // Use minimal history for edits, empty history for new builds
        const session = getOrCreateSession(sessionId);
        const hasExistingApp = existsSync(join(workerSession.workingDir, "index.html"));
        const history = hasExistingApp ? session.messages.slice(-10) : [];

        const result = await runAgent(message, history, {
          apiKey, model,
          provider: provider as AgentOptions["provider"],
          systemPrompt: workerPrompt, tools: workerTools,
          security, toolPolicy, sessionId,
          maxIterations: 15,
        });
        session.messages = stripEphemeralMessages(result.messages).filter(m => m.role !== "system");
        session.updatedAt = Date.now(); saveSession(session);
        return extractAgentOutput(result.messages);
      });
      console.log("[workers] Runner registered");
    }).catch(() => {});

    // Memory background (every 6h + 30s after startup)
    const runMemBg = async () => {
      try { const { MemoryOrchestrator: MO } = await import("./memory-orchestrator.js"); const r = MO.getInstance().runBackground(memoryIndex); console.log(`[memory-bg] ${r.totalTimeMs}ms`); } catch (e) { console.warn("[memory-bg]", (e as Error).message); }
      // Retain structured facts from recent daily logs
      try {
        let totalRetained = 0;
        for (let i = 0; i < 3; i++) {
          const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const facts = memoryIndex.retainFromDailyLog(date);
          totalRetained += facts.length;
        }
        if (totalRetained > 0) console.log(`[memory-bg] Retained ${totalRetained} facts from daily logs`);
      } catch (e) { console.warn("[memory-bg] Retain:", (e as Error).message); }
      // Run reflection (entity pages + opinion confidence)
      try {
        const reflectResult = await memoryIndex.reflect(7);
        if (reflectResult.entitiesUpdated.length > 0 || reflectResult.opinionsUpdated > 0) {
          console.log(`[memory-bg] Reflect: ${reflectResult.entitiesUpdated.length} entities, ${reflectResult.opinionsUpdated} opinions`);
        }
      } catch (e) { console.warn("[memory-bg] Reflect:", (e as Error).message); }
      // Run nightly consolidation (merge duplicates, promote to MIND.md, entity pages)
      try {
        const { MemoryConsolidator: MC } = await import("./memory-consolidation.js");
        const report = MC.getInstance().consolidate();
        if (report.mergedCount > 0 || report.promotedCount > 0) {
          console.log(`[memory-bg] Consolidation: merged=${report.mergedCount} promoted=${report.promotedCount} entities=${report.entityPagesUpdated}`);
        }
      } catch (e) { console.warn("[memory-bg] Consolidation:", (e as Error).message); }
      // Session summaries — process recent sessions (not just stale ones)
      try {
        const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000, recent = sessionStore.list().filter(s => s.updatedAt > cutoff && s.messageCount > 2);
        const dir = join(dataDir, "memory", "session-summaries"); mkdirSync(dir, { recursive: true }); let n = 0;
        for (const meta of recent.slice(0, 30)) {
          const sf = join(dir, `${meta.id}.md`);
          if (existsSync(sf)) continue;
          const sess = sessionStore.load(meta.id);
          if (!sess) continue;
          // Write real summary content, not just title + date
          const userMsgs = sess.messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => (m.content as string).slice(0, 200));
          const agentMsgs = sess.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => (m.content as string).split("\n").filter(l => l.trim())[0]?.slice(0, 200) || "");
          const summary = `# ${sess.title}\n\nDate: ${new Date(sess.createdAt).toISOString().split("T")[0]}\nMessages: ${sess.messages.length}\n\n## Key Exchanges\n${userMsgs.slice(0, 10).map((u, i) => `- User: ${u}\n  Agent: ${agentMsgs[i] || "..."}`).join("\n")}\n`;
          writeFileSync(sf, summary, "utf-8");
          n++;
        }
        if (n > 0) console.log(`[memory-bg] Summarized ${n} sessions`);
      } catch (e) { console.warn("[memory-bg] Summarization:", (e as Error).message); }
    };
    memBgTimer = setInterval(runMemBg, 6 * 60 * 60 * 1000);
    setTimeout(runMemBg, 30_000);
    // Clean up idle worker sessions every 10 minutes
    setInterval(async () => {
      try { const { cleanupIdleWorkers } = await import("./worker-session.js"); const n = cleanupIdleWorkers(); if (n > 0) console.log(`[workers] Cleaned up ${n} idle worker sessions`); } catch {}
    }, 10 * 60 * 1000);
    // Schedule nightly consolidation at 3 AM
    import("./memory-consolidation.js").then(({ MemoryConsolidator: MC }) => { MC.getInstance().scheduleNightly(); console.log("[memory] Nightly consolidation scheduled for 3 AM"); }).catch(e => console.warn("[memory] Failed to schedule nightly:", (e as Error).message));

    // Memory dream agent — periodic deep reflection (checks every 2 hours, runs if 24h+ since last)
    const runDreamCheck = async () => {
      try {
        const { shouldDream, buildDreamPrompt, startDream, completeDream, failDream } = await import("./memory-dream.js");
        if (!shouldDream()) return;
        console.log("[dream] Starting memory consolidation...");
        startDream();
        const { resolveProvider: rp } = await import("./agent-request.js");
        const { provider, apiKey, model } = await rp(config, secretsStore, dataDir);
        // Use a fast/cheap model for dreaming — Haiku for Anthropic, default for others
        const dreamModel = provider === "anthropic" ? "claude-haiku-4-5" : model;
        const dreamPrompt = buildDreamPrompt();
        const dreamSession: Session = { id: `dream-${Date.now()}`, title: "Memory Dream", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        // Dream agent only gets read/write/edit tools — no bash, no network
        const dreamTools = allAgentTools.filter(t => ["read", "write", "edit", "glob", "grep", "memory_search", "memory_save"].includes(t.name));
        const result = await runAgent(dreamPrompt, [], {
          apiKey, model: dreamModel, provider: provider as AgentOptions["provider"],
          systemPrompt: "You are a memory consolidation agent. Your job is to organize and improve the user's memory files based on recent sessions. Be concise and focused.",
          tools: dreamTools, security, toolPolicy, sessionId: `dream-${Date.now()}`,
          maxIterations: 15, temperature: 0.3,
        });
        dreamSession.messages = result.messages.filter(m => m.role !== "system");
        dreamSession.updatedAt = Date.now();
        saveSession(dreamSession);
        const recentCount = sessionStore.list().filter(s => s.updatedAt > Date.now() - 24 * 60 * 60 * 1000).length;
        completeDream(recentCount);
        console.log("[dream] Memory consolidation finished");
      } catch (e) {
        console.warn("[dream] Failed:", (e as Error).message);
        try { const { failDream } = await import("./memory-dream.js"); failDream(); } catch {}
      }
    };
    setInterval(runDreamCheck, 2 * 60 * 60 * 1000); // Check every 2 hours
    setTimeout(runDreamCheck, 5 * 60 * 1000); // First check 5 minutes after startup
    // Sync
    const syncCfg = agentSync.getConfig();
    if (syncCfg.enabled && syncCfg.autoDownload) agentSync.pull().then(r => { if (r.success) console.log(`[sync] Startup pull: ${r.message}`); }).catch(() => {});
    agentSync.startHeartbeat();
  });

  process.on("SIGINT", async () => { clearInterval(memBgTimer); cronService.stop(); agentSync.stopHeartbeat(); EventBus.removeAllListeners(); await agentSync.push().catch(() => {}); await closeAllBrowsers(); memoryIndex.close(); secretsStore.destroy(); try { const { cleanupAllWorktrees } = await import("./agency/worktree.js"); cleanupAllWorktrees(); } catch {} process.exit(0); });
  return server;
}
