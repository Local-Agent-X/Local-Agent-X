import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseMultipart, jsonResponse, corsHeaders, isLoopbackOrigin, checkRateLimit, getRateLimitKey, recordAuthFailure, getAuthFloodGuard } from "../server-utils.js";
import { handleSessionRoutes, handleSecurityRoutes, handleMemoryRoutes, handleAgentRoutes, handleAppRoutes, handleSettingsRoutes, handleBridgeRoutes, handleChatRoutes, handleMcpRoutes, handleAutopilotRoutes, handleKrakenProxyRoutes, handleHealthRoutes } from "../routes/index.js";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import type { LAXConfig, ServerEvent, Session, ToolDefinition } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { RBACManager } from "../rbac.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { CronService } from "../cron-service.js";
import type { IntegrationRegistry } from "../integrations.js";
import type { WhatsAppBridge } from "../whatsapp-bridge.js";
import type { TelegramBridge } from "../telegram-bridge.js";
import type { AgentSync } from "../sync.js";
import type { AppRegistry } from "../app-runtime.js";
import type { AgentRunStore, AgentTemplateStore, IssueStore, ProjectStore } from "../agent-store.js";
import type { ToolRegistry } from "../tool-search.js";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRequestHandler(deps: {
  config: LAXConfig;
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
  dataDir: string;
  publicDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  secretsStore: SecretsStore;
  cronService: CronService;
  integrations: IntegrationRegistry;
  whatsappBridge: WhatsAppBridge;
  telegramBridge: TelegramBridge;
  agentSync: AgentSync;
  appRegistry: AppRegistry;
  agentRunStore: AgentRunStore;
  agentTemplateStore: AgentTemplateStore;
  issueStore: IssueStore;
  projectStore: ProjectStore;
  allAgentTools: ToolDefinition[];
  toolRegistry: ToolRegistry;
  bridgeTools: ToolDefinition[];
  getOrCreateSession: (id: string) => Session;
  saveSession: (s: Session) => void;
  getChatWs: () => ServerContext["chatWs"];
  broadcastAll: (event: Record<string, unknown>) => void;
  activeOnEventBySession: Map<string, (event: ServerEvent) => void>;
  activeBrowserSessionIdRef: { value: string };
}): RequestHandler {
  const {
    config, security, toolPolicy, rbac, dataDir, publicDir, sessionStore, memoryIndex, memoryManager,
    secretsStore, cronService, integrations, whatsappBridge, telegramBridge, agentSync,
    appRegistry, agentRunStore, agentTemplateStore, issueStore, projectStore,
    allAgentTools, toolRegistry, bridgeTools, getOrCreateSession, saveSession,
    getChatWs, broadcastAll, activeOnEventBySession, activeBrowserSessionIdRef,
  } = deps;

  return async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    const method = req.method || "GET";
    const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
    if (method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); res.end(); return; }
    if (url.pathname.startsWith("/api/") && method !== "GET") {
      if (req.headers["sec-fetch-site"] === "cross-site") { json(403, { error: "Cross-origin mutation blocked" }); return; }
      if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) { json(403, { error: "Cross-origin request blocked" }); return; }
    }
    if (url.pathname.startsWith("/api/") && !checkRateLimit(getRateLimitKey(req))) { json(429, { error: "Rate limit exceeded." }); return; }
    let requestRole: Role = "operator";
    const authExempt = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/status", "/api/auth/anthropic/login", "/api/auth/anthropic/logout", "/api/auth/anthropic/status", "/api/health"]);
    const authExemptPrefixes = ["/api/kraken/public/", "/api/kraken/private/"];
    const clientIpRaw = req.socket.remoteAddress || "";
    const isLoopback = clientIpRaw === "127.0.0.1" || clientIpRaw === "::1" || clientIpRaw === "::ffff:127.0.0.1";
    const ua = req.headers["user-agent"] || "";
    const isAgentSelf = isLoopback && (ua.includes("LocalAgentX") || ua.includes("SecretAgentX"));
    if (isAgentSelf) authExempt.add(url.pathname);
    if (url.pathname.startsWith("/api/") && !authExempt.has(url.pathname) && !authExemptPrefixes.some(p => url.pathname.startsWith(p))) {
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
    const ctx: ServerContext = {
      config, security, toolPolicy, rbac, dataDir, publicDir, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations,
      whatsappBridge, telegramBridge, agentSync, appRegistry, agentRunStore, agentTemplateStore, issueStore, projectStore,
      allAgentTools, toolRegistry, bridgeTools, getOrCreateSession, saveSession, chatWs: getChatWs(), broadcastAll,
      getActiveOnEvent: (sid) => activeOnEventBySession.get(sid),
      setActiveOnEvent: (sid, fn) => {
        if (fn) activeOnEventBySession.set(sid, fn);
        else activeOnEventBySession.delete(sid);
      },
      activeBrowserSessionId: activeBrowserSessionIdRef.value,
      setActiveBrowserSessionId: (id) => { activeBrowserSessionIdRef.value = id; },
    };
    for (const h of [handleHealthRoutes, handleSessionRoutes, handleChatRoutes, handleMemoryRoutes, handleSecurityRoutes, handleAgentRoutes, handleAppRoutes, handleBridgeRoutes, handleSettingsRoutes, handleMcpRoutes, handleAutopilotRoutes, handleKrakenProxyRoutes]) {
      if (await h(method, url, req, res, ctx, requestRole)) return;
    }
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
    if (method === "GET" && ["/uploads/", "/videos/", "/images/", "/files/"].some(r => url.pathname.startsWith(r))) {
      const provided = ((req.headers.authorization || "").startsWith("Bearer ") ? (req.headers.authorization || "").slice(7) : "") || url.searchParams.get("token") || "";
      if (!provided || provided.length !== config.authToken.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(config.authToken))) { json(401, { error: "Authentication required" }); return; }
    }
    if (method === "GET" && url.pathname.startsWith("/uploads/")) {
      const fn = url.pathname.replace("/uploads/", ""); if (/[^a-zA-Z0-9._-]/.test(fn)) { json(400, { error: "Invalid filename" }); return; }
      const fp = join(dataDir, "uploads", fn); if (!existsSync(fp)) { json(404, { error: "File not found" }); return; }
      const ext = fn.split(".").pop() || "", ct: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv" };
      const h: Record<string, string> = { ...corsHeaders(req), "Content-Type": ct[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
      if (ext === "svg") h["Content-Security-Policy"] = "script-src 'none'";
      res.writeHead(200, h); res.end(readFileSync(fp)); return;
    }
    for (const [prefix, subdir] of [["/videos/", "videos"], ["/images/", "images"]] as const) {
      if (method === "GET" && url.pathname.startsWith(prefix)) {
        const dir = resolve(config.workspace, subdir), file = resolve(dir, url.pathname.replace(prefix, "")), rel = relative(dir, file);
        if (rel.startsWith("..") || url.pathname.includes("\x00")) { json(403, { error: "Path traversal blocked" }); return; }
        if (existsSync(file)) { const ext = file.split(".").pop() || ""; const ct: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }; res.writeHead(200, { "Content-Type": ct[ext] || "application/octet-stream" }); res.end(readFileSync(file)); return; }
      }
    }
    if (method === "GET" && url.pathname.startsWith("/files/")) {
      const filePath = decodeURIComponent(url.pathname.slice(7));
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
    if (method === "GET" && url.pathname.startsWith("/apps/")) {
      const appsDir = resolve(config.workspace);
      let appFile = resolve(appsDir, "." + url.pathname);
      try {
        if (existsSync(appFile) && statSync(appFile).isDirectory()) {
          const idx = resolve(appFile, "index.html");
          if (existsSync(idx)) appFile = idx;
        }
      } catch {}
      const rel = relative(appsDir, appFile);
      if (rel.startsWith("..")) { json(403, { error: "Path traversal blocked" }); return; }
      if (existsSync(appFile)) {
        const ext = appFile.split(".").pop() || "", ct: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml" };
        const h: Record<string, string> = { "Content-Type": ct[ext] || "application/octet-stream" };
        if (ext === "html") {
          h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'";
          h["X-Content-Type-Options"] = "nosniff"; h["X-Frame-Options"] = "SAMEORIGIN"; h["Referrer-Policy"] = "no-referrer"; h["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()";
          h["Cache-Control"] = "no-cache, must-revalidate"; h["Pragma"] = "no-cache";
          let html = readFileSync(appFile, "utf-8");
          const iso = `<script>sessionStorage.removeItem('sax_token');localStorage.removeItem('sax_token');delete window.__AUTH_TOKEN__;history.replaceState(null,'',location.pathname);</script>`;
          html = html.includes("<head>") ? html.replace("<head>", "<head>" + iso) : html.includes("<body>") ? html.replace("<body>", "<body>" + iso) : iso + html;
          res.writeHead(200, h); res.end(html); return;
        }
        res.writeHead(200, h); res.end(readFileSync(appFile)); return;
      }
    }
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
}
