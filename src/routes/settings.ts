import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeParseBody, safeErrorMessage, corsHeaders } from "../server-utils.js";
import { getToolStats, getToolSuccessRate, getRecentFailures } from "../tool-tracker.js";
import { getProviderHealthStatus } from "../model-fallback.js";
import { getThreatDashboard } from "../threat-dashboard.js";

/** Typed cache for update check results stored on the module scope */
interface UpdateCheckResult { localVersion: string; localCommit: string; remoteVersion: string; remoteCommit: string; updateAvailable: boolean; releaseNotes: string }
let _updateCache: { data: UpdateCheckResult; time: number } | null = null;

/** GitHub commit response shape */
interface GitHubCommitResponse { sha?: string; commit?: { message?: string } }

/** GitHub package.json response shape */
interface GitHubPackageResponse { version?: string }
import { getCrashReport, getTopCrashPatterns } from "../crash-analytics.js";
import { getContextUsage } from "../context-usage.js";
import { runStartupTests } from "../startup-test.js";
import { generateFullSpec } from "../api-docs.js";
import { PluginManager } from "../plugin-system.js";
import { setBrowserAuthContext } from "../browser.js";
import { redactCredentials } from "../security.js";
import { IntegrationRegistry } from "../integrations.js";
import { getRuntimeConfig } from "../config.js";

export const handleSettingsRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Health
  if (method === "GET" && url.pathname === "/api/health") {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    json(200, {
      status: "ok", uptime: Math.round(uptime), version: "0.1.0",
      memory: { heapUsedMB: Math.round(mem.heapUsed / 1048576), heapTotalMB: Math.round(mem.heapTotal / 1048576), rssMB: Math.round(mem.rss / 1048576) },
      toolStats: getToolStats(),
    }); return true;
  }

  // System status
  if (method === "GET" && url.pathname === "/api/system-status") {
    const { getSandboxMode, isDockerAvailable } = await import("../sandbox.js");
    const threatData = getThreatDashboard();
    const providerHealth = getProviderHealthStatus();
    const tStats = getToolStats();
    json(200, {
      profile: ctx.config.profile, toolApproval: ctx.config.toolApproval,
      retentionDays: ctx.config.retentionDays, autoUpdate: ctx.config.autoUpdate, logLevel: ctx.config.logLevel,
      sandbox: { mode: getSandboxMode(), dockerAvailable: isDockerAvailable() },
      security: { threatsBlocked: threatData.stats?.totalBlocked || 0, threatLevel: threatData.currentThreatLevel || "normal", recentEvents: (threatData.recentEvents || []).slice(0, 5) },
      providers: providerHealth,
      tools: { totalCalls: Object.values(tStats).reduce((sum, t) => sum + (t.totalCalls || 0), 0), successRate: getToolSuccessRate(), recentFailures: getRecentFailures(5) },
      uptime: Math.floor(process.uptime()), memoryUsage: process.memoryUsage().heapUsed, nodeVersion: process.version,
    }); return true;
  }

  // Profile switch
  if (method === "POST" && url.pathname === "/api/profile") {
    const body = await readBody(req);
    const { profile } = JSON.parse(body);
    if (!["home", "dev", "enterprise"].includes(profile)) { json(400, { error: "Invalid profile" }); return true; }
    const { PROFILE_DEFAULTS, saveConfig } = await import("../config.js");
    const defaults = PROFILE_DEFAULTS[profile as keyof typeof PROFILE_DEFAULTS];
    ctx.config.profile = profile;
    ctx.config.toolApproval = defaults.toolApproval;
    ctx.config.retentionDays = defaults.retentionDays;
    ctx.config.autoUpdate = defaults.autoUpdate;
    ctx.config.logLevel = defaults.logLevel;
    saveConfig(ctx.config);
    json(200, { ok: true, profile, applied: defaults }); return true;
  }

  // Sandbox
  if (method === "GET" && url.pathname === "/api/sandbox") {
    const { getSandboxMode, isDockerAvailable } = await import("../sandbox.js");
    json(200, { mode: getSandboxMode(), dockerAvailable: isDockerAvailable(), dockerDownloadUrl: "https://www.docker.com/products/docker-desktop/" }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sandbox") {
    const body = await readBody(req);
    const { mode } = JSON.parse(body);
    if (mode !== "host" && mode !== "docker") { json(400, { error: "Invalid mode" }); return true; }
    const { setSandboxMode } = await import("../sandbox.js");
    const result = setSandboxMode(mode);
    json(result.ok ? 200 : 400, result); return true;
  }

  // Update checker
  if (method === "GET" && url.pathname === "/api/updates/check") {
    try {
      const pkgPath = join(import.meta.dirname || ".", "..", "package.json");
      const localPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const localVersion = localPkg.version || "0.0.0";
      let localCommit = "";
      try { const { execSync } = await import("node:child_process"); localCommit = execSync("git rev-parse --short HEAD", { cwd: join(import.meta.dirname || ".", ".."), encoding: "utf-8" }).trim(); } catch {}
      const now = Date.now();
      if (_updateCache && now - _updateCache.time < 3600000) {
        json(200, { ..._updateCache.data, localVersion, localCommit, cached: true }); return true;
      }
      let remoteVersion = localVersion, remoteCommit = "", updateAvailable = false, releaseNotes = "";
      try {
        const commitRes = await fetch("https://api.github.com/repos/petermanrique101-sys/Open-Agent-X/commits/main", { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Open-Agent-X" } });
        if (commitRes.ok) { const d = await commitRes.json() as GitHubCommitResponse; remoteCommit = d.sha?.slice(0, 7) || ""; releaseNotes = d.commit?.message?.split("\n")[0] || ""; }
        const pkgRes = await fetch("https://raw.githubusercontent.com/petermanrique101-sys/Open-Agent-X/main/package.json", { headers: { "User-Agent": "Open-Agent-X" } });
        if (pkgRes.ok) { remoteVersion = (await pkgRes.json() as GitHubPackageResponse).version || localVersion; }
        updateAvailable = (remoteCommit && localCommit && remoteCommit !== localCommit) || remoteVersion !== localVersion;
      } catch {}
      const result: UpdateCheckResult = { localVersion, localCommit, remoteVersion, remoteCommit, updateAvailable, releaseNotes };
      _updateCache = { data: result, time: now };
      json(200, result);
    } catch (e) { json(200, { updateAvailable: false, error: safeErrorMessage(e) }); }
    return true;
  }

  // Tool stats
  if (method === "GET" && url.pathname === "/api/tools/stats") {
    json(200, { stats: getToolStats(), successRate: getToolSuccessRate(), recentFailures: getRecentFailures(20) }); return true;
  }

  // Crashes
  if (method === "GET" && url.pathname === "/api/crashes") {
    json(200, { report: getCrashReport(), topPatterns: getTopCrashPatterns(10) }); return true;
  }

  // Context usage
  if (method === "GET" && url.pathname === "/api/context/usage") {
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const session = ctx.getOrCreateSession(sessionId);
      if (session) { json(200, getContextUsage(session.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>, 128000)); return true; }
    }
    json(200, { used: 0, max: 128000, percentage: 0, remaining: 128000 }); return true;
  }

  // Startup tests
  if (method === "GET" && url.pathname === "/api/startup-tests") {
    json(200, { results: await runStartupTests() }); return true;
  }

  // API docs
  if (method === "GET" && url.pathname === "/api/docs") {
    json(200, generateFullSpec()); return true;
  }

  // Plugins
  if (method === "GET" && url.pathname === "/api/plugins") {
    json(200, new PluginManager().listPlugins()); return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/load") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try { json(200, { ok: true, plugin: await new PluginManager().loadPlugin(String(body.path)) }); } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/plugins/unload") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    json(200, { ok: new PluginManager().unloadPlugin(String(body.id)) }); return true;
  }

  // Settings CRUD
  if (method === "POST" && url.pathname === "/api/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    const settingsPath = join(ctx.dataDir, "settings.json");
    let existing: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const merged = { ...existing, ...body };
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
    if (body.port) {
      const configPath = join(ctx.dataDir, "config.json");
      let cfg: Record<string, unknown> = {};
      try { if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      cfg.port = parseInt(String(body.port), 10);
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), { encoding: "utf-8", mode: 0o600 });
    }
    json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/settings") {
    const settingsPath = join(ctx.dataDir, "settings.json");
    try {
      if (existsSync(settingsPath)) { json(200, JSON.parse(readFileSync(settingsPath, "utf-8"))); }
      else { json(200, {}); }
    } catch { json(200, {}); }
    return true;
  }

  // Providers
  if (method === "GET" && url.pathname === "/api/providers") {
    const { loadTokens } = await import("../auth.js");
    const { loadAnthropicTokens } = await import("../auth-anthropic.js");
    const providers: Array<{ id: string; name: string; models: string[]; active: boolean }> = [];
    const hasOpenAIOAuth = !!loadTokens();
    const hasAnthropicOAuth = !!loadAnthropicTokens();
    const hasXaiKey = ctx.secretsStore.has("XAI_API_KEY");
    const hasOpenAIKey = !!ctx.config.openaiApiKey || ctx.secretsStore.has("OPENAI_API_KEY");
    let hasOllama = false;
    const ollamaUrl = getRuntimeConfig().ollamaUrl;
    try { const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) }); hasOllama = r.ok; } catch {}
    let currentProvider = "xai", currentModel = "grok-3-mini";
    try { const sp = join(ctx.dataDir, "settings.json"); if (existsSync(sp)) { const s = JSON.parse(readFileSync(sp, "utf-8")); currentProvider = s.provider || "xai"; currentModel = s.model || ""; } } catch {}
    const hasGeminiKey = ctx.secretsStore.has("GEMINI_API_KEY");
    const hasCustomKey = ctx.secretsStore.has("CUSTOM_API_KEY");
    if (hasXaiKey) providers.push({ id: "xai", name: "xAI Grok", models: ["grok-3-mini", "grok-3", "grok-2"], active: currentProvider === "xai" });
    if (hasGeminiKey) providers.push({ id: "gemini", name: "Google Gemini", models: ["gemini-2.0-flash", "gemini-2.5-pro-preview-05-06", "gemini-2.5-flash-preview-05-20"], active: currentProvider === "gemini" });
    if (hasOpenAIOAuth) providers.push({ id: "codex", name: "OpenAI Codex", models: ["gpt-5.3-codex", "gpt-4o", "gpt-4o-mini", "o3-pro"], active: currentProvider === "codex" });
    if (hasAnthropicOAuth) providers.push({ id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"], active: currentProvider === "anthropic" });
    if (hasOpenAIKey) providers.push({ id: "openai", name: "OpenAI API", models: ["gpt-4o", "gpt-4o-mini", "o3-pro"], active: currentProvider === "openai" });
    if (hasOllama) {
      let ollamaModels: string[] = [];
      try { const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) }); const d = await r.json() as { models?: Array<{ name: string }> }; ollamaModels = (d.models || []).map(m => m.name); } catch {}
      providers.push({ id: "local", name: "Ollama", models: ollamaModels, active: currentProvider === "local" });
    }
    if (hasCustomKey) providers.push({ id: "custom", name: "Custom Provider", models: ["custom-model"], active: currentProvider === "custom" });
    json(200, { providers, current: { provider: currentProvider, model: currentModel } }); return true;
  }

  // Switch provider
  if (method === "POST" && url.pathname === "/api/providers/switch") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const provider = String(body.provider || "");
    const model = String(body.model || "");
    if (!provider) { json(400, { error: "provider required" }); return true; }
    const settingsPath = join(ctx.dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    settings.provider = provider;
    if (model) settings.model = model;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    json(200, { ok: true, provider, model: model || settings.model }); return true;
  }

  // Local models
  if (method === "GET" && url.pathname === "/api/models/local") {
    try {
      const ollamaRes = await fetch(`${getRuntimeConfig().ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!ollamaRes.ok) { json(502, { error: "Ollama returned " + ollamaRes.status }); return true; }
      const data = await ollamaRes.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      json(200, { models: (data.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at })) });
    } catch { json(502, { error: "Ollama not running. Start it with: ollama serve" }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/ollama/start") {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      json(200, { ok: true, message: "Ollama starting..." });
    } catch (e: unknown) { json(500, { error: "Failed to start Ollama: " + (e instanceof Error ? e.message : String(e)) }); }
    return true;
  }

  // Token rotation
  if (method === "POST" && url.pathname === "/api/auth/rotate") {
    const newToken = randomBytes(32).toString("hex");
    const configPath = join(ctx.dataDir, "config.json");
    try {
      const cfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};
      cfg.authToken = newToken;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      ctx.config.authToken = newToken;
      const { RBACManager } = await import("../rbac.js");
      Object.assign(ctx.rbac, new RBACManager(ctx.dataDir, newToken));
      setBrowserAuthContext(newToken, String(ctx.config.port));
      const masked = newToken.slice(0, 4) + "****" + newToken.slice(-4);
      console.log(`[auth] Token rotated. New token: ${masked}`);
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

  // Mood detection
  if (method === "POST" && url.pathname === "/api/mood/detect") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const text = String(body.text || "");
    if (!text) { json(400, { error: "text required" }); return true; }
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
    const exclamations = (text.match(/!/g) || []).length;
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
    if (exclamations > 2) urgentScore++;
    if (capsRatio > 0.5 && text.length > 10) urgentScore++;
    let mood = "neutral", tone = "balanced", confidence = 0.5;
    if (posScore > negScore && posScore > 0) { mood = "positive"; confidence = Math.min(0.9, 0.5 + posScore * 0.1); }
    else if (negScore > posScore && negScore > 0) { mood = "negative"; confidence = Math.min(0.9, 0.5 + negScore * 0.1); }
    else if (urgentScore > 0) { mood = "urgent"; confidence = Math.min(0.9, 0.5 + urgentScore * 0.15); }
    if (casualScore > formalScore) tone = "casual";
    else if (formalScore > casualScore) tone = "formal";
    let styleHint = "";
    if (mood === "negative") styleHint = "User seems frustrated. Be empathetic and focus on solutions.";
    else if (mood === "urgent") styleHint = "User has urgency. Be concise, prioritize action.";
    else if (mood === "positive") styleHint = "User is in a good mood. Match their energy.";
    if (tone === "casual") styleHint += " Keep responses casual.";
    else if (tone === "formal") styleHint += " Match their formal tone.";
    json(200, { mood, tone, confidence, styleHint, scores: { positive: posScore, negative: negScore, urgent: urgentScore, casual: casualScore, formal: formalScore } });
    return true;
  }

  // Custom pages
  if (method === "GET" && url.pathname === "/api/custom-pages") {
    const registryPath = join(ctx.dataDir, "custom-pages.json");
    try { if (existsSync(registryPath)) { json(200, JSON.parse(readFileSync(registryPath, "utf-8"))); } else { json(200, []); } } catch { json(200, []); }
    return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/custom-pages/")) {
    const pageName = url.pathname.split("/").pop() || "";
    if (!pageName || /[^a-zA-Z0-9_-]/.test(pageName)) { json(400, { error: "Invalid page name" }); return true; }
    const registryPath = join(ctx.dataDir, "custom-pages.json");
    try {
      let registry: Array<{ name: string }> = [];
      if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      registry = registry.filter(p => p.name !== pageName);
      writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
    } catch {}
    const filePath = join(ctx.publicDir, `${pageName}.html`);
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(filePath); } catch {}
    json(200, { ok: true, deleted: pageName }); return true;
  }

  // Usage/cost report API
  if (method === "GET" && url.pathname === "/api/usage") {
    try {
      const { getUsageSummary, getTodayCost } = await import("../cost-tracker.js");
      const period = url.searchParams.get("period") || "today";
      if (period === "today") {
        json(200, getTodayCost());
      } else {
        const since = period === "week" ? Date.now() - 7 * 86400000 : period === "month" ? Date.now() - 30 * 86400000 : undefined;
        json(200, getUsageSummary({ since }));
      }
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  // Doctor / self-diagnostics API
  if (method === "GET" && url.pathname === "/api/doctor") {
    try {
      const { runDoctor } = await import("../doctor.js");
      const report = await runDoctor();
      json(200, report);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  return false;
};
