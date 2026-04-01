import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeParseBody, safeErrorMessage, corsHeaders } from "../server-utils.js";

export const handleBridgeRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── WhatsApp ──
  if (method === "POST" && url.pathname === "/api/whatsapp/connect") {
    try { json(200, await ctx.whatsappBridge.connect()); } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/disconnect") {
    await ctx.whatsappBridge.disconnect(); json(200, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/reset") {
    await ctx.whatsappBridge.reset(); json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/whatsapp/status") {
    json(200, await ctx.whatsappBridge.getStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/send") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { to, message: msg } = body;
      if (!to || !msg) { json(400, { error: "to and message are required" }); return true; }
      const ok = await ctx.whatsappBridge.sendMessage(to, msg);
      json(ok ? 200 : 500, { ok, error: ok ? undefined : "Failed to send" });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/allowed-numbers") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      ctx.whatsappBridge.setAllowedNumbers(body.numbers || []);
      json(200, { ok: true, numbers: body.numbers || [] });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  // ── Telegram ──
  if (method === "POST" && url.pathname === "/api/telegram/connect") {
    try { json(200, await ctx.telegramBridge.connect()); } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/telegram/disconnect") {
    ctx.telegramBridge.disconnect(); json(200, { ok: true }); return true;
  }
  if (method === "GET" && url.pathname === "/api/telegram/status") {
    json(200, { ...ctx.telegramBridge.getStatus(), hasToken: ctx.secretsStore.has("TELEGRAM_BOT_TOKEN") }); return true;
  }
  if (method === "POST" && url.pathname === "/api/telegram/send") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const { chatId, message: msg } = body;
      if (!chatId || !msg) { json(400, { error: "chatId and message are required" }); return true; }
      json(await ctx.telegramBridge.sendMessage(chatId, msg) ? 200 : 500, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  // ── Sync ──
  if (method === "GET" && url.pathname === "/api/sync/status") {
    json(200, ctx.agentSync.getStatus()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/configure") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.agentSync.saveConfig(body);
    ctx.agentSync.stopHeartbeat();
    ctx.agentSync.startHeartbeat();
    json(200, { ok: true }); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/push") {
    json(200, await ctx.agentSync.push()); return true;
  }
  if (method === "POST" && url.pathname === "/api/sync/pull") {
    json(200, await ctx.agentSync.pull()); return true;
  }

  // ── Protocols ──
  if (method === "GET" && url.pathname === "/api/protocols") {
    try {
      const { getAllMissions } = await import("../missions.js");
      const catMap: Record<string, string> = {
        instagram: "Social Media", twitter: "Social Media", facebook: "Social Media", tiktok: "Social Media",
        git: "Developer", deploy: "Developer", test: "Developer", pr: "Developer",
        research: "Research", summarize: "Research",
        email: "Communication", slack: "Communication", discord: "Communication", whatsapp: "Communication",
        smart: "Smart Home", light: "Smart Home",
      };
      function getCategory(name: string): string {
        for (const [key, cat] of Object.entries(catMap)) { if (name.includes(key)) return cat; }
        return "General";
      }
      const protocols = getAllMissions().map(m => ({
        name: m.name, description: m.description,
        triggers: m.triggers.slice(0, 3), steps: m.steps.length, category: getCategory(m.name),
      }));
      json(200, { protocols });
    } catch { json(200, { protocols: [] }); }
    return true;
  }

  // ── Missions/Cron ──
  if (method === "GET" && url.pathname === "/api/missions") {
    json(200, { schedules: ctx.cronService.list() }); return true;
  }
  if (method === "GET" && (url.pathname === "/api/cron" || url.pathname === "/api/schedules")) {
    json(200, { jobs: ctx.cronService.list(), settings: ctx.cronService.getSettings() }); return true;
  }
  if (method === "POST" && url.pathname === "/api/cron") {
    const body = await safeParseBody(req) as { name?: string; schedule?: string; prompt?: string; systemJob?: boolean };
    if (!body.name || !body.schedule || !body.prompt) { json(400, { error: "name, schedule, and prompt are required" }); return true; }
    try { json(200, { ok: true, job: ctx.cronService.create(body.name, body.schedule, body.prompt, body.systemJob) }); }
    catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "PATCH" && url.pathname.startsWith("/api/cron/")) {
    const id = url.pathname.split("/").pop()!;
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    try {
      const job = ctx.cronService.update(id, body);
      if (!job) { json(404, { error: "Job not found" }); return true; }
      json(200, { ok: true, job });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/cron/")) {
    json(200, { ok: true, deleted: ctx.cronService.delete(url.pathname.split("/").pop()!) }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/toggle$/)) {
    const job = ctx.cronService.toggle(url.pathname.split("/")[3]);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    json(200, { ok: true, job }); return true;
  }
  if (method === "POST" && url.pathname.match(/^\/api\/cron\/[^/]+\/run$/)) {
    const id = url.pathname.split("/")[3];
    const job = ctx.cronService.get(id);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    json(200, { ok: true, message: `Job "${job.name}" triggered` });
    ctx.cronService["executeJob"](job).catch(() => {});
    return true;
  }
  if (method === "POST" && url.pathname === "/api/cron/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.cronService.updateSettings(body);
    json(200, { ok: true, settings: ctx.cronService.getSettings() }); return true;
  }

  // ── Voice ──
  if (method === "GET" && url.pathname === "/api/voice/capabilities") {
    const { detectCapabilities } = await import("../voice.js");
    json(200, await detectCapabilities()); return true;
  }
  if (method === "GET" && url.pathname.startsWith("/api/voice/preview/")) {
    const voiceId = url.pathname.split("/").pop() || "";
    if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) { json(400, { error: "Invalid voice ID" }); return true; }
    try {
      const r = await fetch(`http://127.0.0.1:7862/voices/${voiceId}/preview`);
      if (r.ok && r.body) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(buf.length) });
        res.end(buf);
      } else { json(404, { error: "Voice not found" }); }
    } catch { json(502, { error: "XTTS server not reachable" }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/voice/start-xtts") {
    try {
      try { const h = await fetch("http://127.0.0.1:7862/health", { signal: AbortSignal.timeout(1000) }); if (h.ok) { json(200, { ok: true, status: "already running" }); return true; } } catch {}
      const { spawn } = await import("node:child_process");
      const scriptPath = join(process.cwd(), "scripts", "xtts-server.py");
      const child = spawn("python", [scriptPath], { detached: true, stdio: "ignore", env: { ...process.env, XTTS_PORT: "7862" } });
      child.unref();
      await new Promise(r => setTimeout(r, 2000));
      json(200, { ok: true, status: "started", pid: child.pid });
    } catch { json(500, { error: "Failed to start XTTS" }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/voice/transcribe") {
    try {
      const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let audioSize = 0;
      for await (const chunk of req) {
        audioSize += (chunk as Buffer).length;
        if (audioSize > MAX_AUDIO_BYTES) { json(413, { error: "Audio too large" }); req.destroy(); return true; }
        chunks.push(chunk as Buffer);
      }
      const audioBuffer = Buffer.concat(chunks);
      if (audioBuffer.length < 1000) { json(400, { error: "Audio too short" }); return true; }
      const { transcribe } = await import("../voice.js");
      json(200, { text: transcribe(audioBuffer) });
    } catch { json(500, { error: "Transcription failed" }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/voice/synthesize") {
    try {
      const body = await safeParseBody(req) as { text?: string; voice?: string; speed?: number };
      if (!body.text?.trim()) { json(400, { error: "text is required" }); return true; }
      const { synthesize } = await import("../voice.js");
      const wavBuffer = await synthesize(body.text, body.voice, body.speed);
      if (wavBuffer.length === 0) { json(500, { error: "TTS engine not available" }); return true; }
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(wavBuffer.length), ...corsHeaders(req) });
      res.end(wavBuffer);
    } catch { json(500, { error: "Synthesis failed" }); }
    return true;
  }

  // ── Secrets ──
  if (method === "GET" && url.pathname === "/api/secrets") {
    json(200, ctx.secretsStore.list()); return true;
  }
  if (method === "POST" && url.pathname === "/api/secrets") {
    const body = await safeParseBody(req) as { name?: string; value?: string; service?: string };
    const name = body.name?.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!name || !body.value) { json(400, { error: "name and value are required" }); return true; }
    ctx.secretsStore.set(name, body.value, body.service);
    json(200, { ok: true, name }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/secrets/")) {
    const name = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[A-Z0-9_]{1,64}$/i.test(name)) { json(400, { error: "Invalid secret name" }); return true; }
    json(200, { ok: true, deleted: ctx.secretsStore.delete(name) }); return true;
  }

  // ── Integrations ──
  if (method === "GET" && url.pathname === "/api/integrations") {
    json(200, ctx.integrations.list()); return true;
  }
  if (method === "GET" && url.pathname === "/api/integrations/schema") {
    json(200, { schema: IntegrationRegistry.getIntegrationSchema() }); return true;
  }
  if (method === "GET" && url.pathname.startsWith("/api/integrations/") && !url.pathname.includes("install") && !url.pathname.includes("uninstall") && !url.pathname.includes("toggle") && !url.pathname.includes("test") && !url.pathname.includes("schema")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const config = ctx.integrations.get(id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    json(200, config); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/install") {
    const body = await safeParseBody(req) as { id: string; secretValue?: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    if (body.secretValue) ctx.secretsStore.set(config.secretName, body.secretValue, config.name);
    ctx.integrations.markInstalled(body.id, true);
    json(200, { ok: true, id: body.id, secretName: config.secretName }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/uninstall") {
    const body = await safeParseBody(req) as { id: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    ctx.secretsStore.delete(config.secretName);
    ctx.integrations.markInstalled(body.id, false);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/toggle") {
    const body = await safeParseBody(req) as { id: string; enabled: boolean };
    ctx.integrations.setEnabled(body.id, body.enabled);
    json(200, { ok: true, id: body.id, enabled: body.enabled }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    if (!body.id || !body.name || !body.baseUrl) { json(400, { error: "id, name, and baseUrl are required" }); return true; }
    body.builtin = false; body.installed = false; body.enabled = true;
    if (!body.endpoints) body.endpoints = [];
    if (!body.headers) body.headers = {};
    ctx.integrations.addIntegration(body);
    json(200, { ok: true, id: body.id }); return true;
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/integrations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { json(400, { error: "Invalid integration ID" }); return true; }
    const removed = ctx.integrations.removeIntegration(id);
    if (!removed) { json(400, { error: "Cannot delete built-in integration" }); return true; }
    json(200, { ok: true, deleted: id }); return true;
  }
  if (method === "POST" && url.pathname === "/api/integrations/test") {
    const body = await safeParseBody(req) as { id: string };
    const config = ctx.integrations.get(body.id);
    if (!config) { json(404, { error: "Integration not found" }); return true; }
    const token = ctx.secretsStore.get(config.secretName);
    if (!token) { json(400, { error: `No credentials found. Save your ${config.secretName} first.` }); return true; }
    try {
      let testUrl: string;
      const headers: Record<string, string> = { ...config.headers };
      if (config.id === "google" && config.authType === "api_key") {
        testUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1`;
        headers["X-Goog-Api-Key"] = token;
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
    } catch (e: any) { json(200, { ok: false, error: e.message }); }
    return true;
  }

  // ── Auth ──
  if (method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const { initiateOAuthLogin } = await import("../auth.js");
      const { authUrl, promise } = initiateOAuthLogin();
      promise.then(() => console.log("[auth] OAuth login completed")).catch((e) => console.warn("[auth] OAuth login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      const { getAuthPath } = await import("../config.js");
      const { unlinkSync, existsSync } = await import("node:fs");
      const authPath = getAuthPath();
      if (existsSync(authPath)) unlinkSync(authPath);
      json(200, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/status") {
    const { loadTokens } = await import("../auth.js");
    const tokens = loadTokens();
    const operatorEntry = ctx.rbac.listTokens().find((t: any) => t.id === "operator-default");
    const expiresAt = operatorEntry?.expiresAt || null;
    const daysRemaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    json(200, {
      authenticated: !!tokens || !!ctx.config.openaiApiKey,
      method: ctx.config.openaiApiKey ? "api_key" : tokens ? "oauth" : "none",
      tokenExpiresAt: expiresAt, tokenDaysRemaining: daysRemaining,
      tokenExpiringSoon: daysRemaining !== null && daysRemaining <= 7,
    }); return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/login") {
    try {
      const { initiateAnthropicLogin } = await import("../auth-anthropic.js");
      const { authUrl, promise } = initiateAnthropicLogin();
      promise.then(() => console.log("[anthropic-auth] Login completed")).catch((e) => console.warn("[anthropic-auth] Login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
    try { const { deleteAnthropicTokens } = await import("../auth-anthropic.js"); deleteAnthropicTokens(); json(200, { ok: true }); }
    catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
    const { loadAnthropicTokens } = await import("../auth-anthropic.js");
    const tokens = loadAnthropicTokens();
    let cliInstalled = false;
    try { const { execSync } = await import("node:child_process"); execSync("claude --version", { timeout: 5000, stdio: "pipe" }); cliInstalled = true; } catch {}
    json(200, { authenticated: !!tokens, method: tokens ? "oauth" : "none", expired: tokens ? Date.now() > tokens.expiresAt : false, cliInstalled }); return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/install-cli") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("npm install -g @anthropic-ai/claude-code", { timeout: 120_000 });
      let version = "unknown";
      try { const { execSync } = await import("node:child_process"); version = execSync("claude --version", { timeout: 5000, stdio: "pipe" }).toString().trim(); } catch {}
      json(200, { ok: true, version, output: (stdout + stderr).slice(-500) });
    } catch (e) { json(500, { error: `Install failed: ${safeErrorMessage(e)}` }); }
    return true;
  }

  return false;
};

// Re-import IntegrationRegistry for static method access
import { IntegrationRegistry } from "../integrations.js";
