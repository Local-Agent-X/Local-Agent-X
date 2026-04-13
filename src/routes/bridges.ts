import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RouteHandler } from "../server-context.js";
import { jsonResponse, readBody, safeParseBody, safeErrorMessage, corsHeaders } from "../server-utils.js";
import { getRuntimeConfig } from "../config.js";

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
      const { to, message: msg } = body as { to?: string; message?: string };
      if (!to || !msg) { json(400, { error: "to and message are required" }); return true; }
      const ok = await ctx.whatsappBridge.sendMessage(to, msg);
      json(ok ? 200 : 500, { ok, error: ok ? undefined : "Failed to send" });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/whatsapp/allowed-numbers") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      ctx.whatsappBridge.setAllowedNumbers((body.numbers || []) as string[]);
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
      const { chatId, message: msg } = body as { chatId?: string; message?: string };
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

  // ── Protocols (reusable workflows: built-in protocols + user-defined skills) ──
  if (method === "GET" && url.pathname === "/api/protocols") {
    try {
      const { getAllProtocols } = await import("../protocols.js");
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
      // Built-in protocol workflows
      const protocols = getAllProtocols().map(m => ({
        name: m.name, description: m.description,
        triggers: m.triggers.slice(0, 3), steps: m.steps.length, category: getCategory(m.name),
      }));
      // User-defined skills (SKILL.md files)
      try {
        const { getSkillRegistry } = await import("../skills/skill-loader.js");
        const registry = getSkillRegistry();
        registry.reload();
        for (const s of registry.list()) {
          protocols.push({
            name: s.metadata.name, description: s.metadata.description || "",
            triggers: [s.id], steps: 0, category: getCategory(s.id) === "General" ? "Custom" : getCategory(s.id),
          });
        }
      } catch {}
      json(200, { protocols });
    } catch { json(200, { protocols: [] }); }
    return true;
  }

  // ── Scheduled Missions ──
  if (method === "GET" && (url.pathname === "/api/missions" || url.pathname === "/api/cron" || url.pathname === "/api/schedules")) {
    json(200, { missions: ctx.cronService.list(), settings: ctx.cronService.getSettings() }); return true;
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
  if (method === "DELETE" && url.pathname.match(/^\/api\/cron\/[^/]+$/)) {
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
  // Live status of a cron job — includes any active sub-agents for this job
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/status$/)) {
    const id = url.pathname.split("/")[3];
    const job = ctx.cronService.get(id);
    if (!job) { json(404, { error: "Job not found" }); return true; }
    const running = (ctx.cronService as unknown as { running: Set<string> }).running?.has(id) || false;
    let subAgents: Array<{ id: string; name: string; role: string; status: string; currentTask?: string; tokensUsed: number; elapsed: number; recentTools: string[] }> = [];
    try {
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      const agentsRaw = (handler as unknown as { agents: Map<string, { id: string; name: string; role: string; status: string; currentTask?: string; tokensUsed: number; startedAt: number; parentSessionId?: string; output: string[] }> }).agents;
      // Find sub-agents whose parentSessionId starts with cron-{id}
      const children = [...agentsRaw.values()].filter(a => a.parentSessionId?.startsWith(`cron-${id}-`));
      subAgents = children.map(a => {
        // Extract recent tool activity from output log (entries starting with [tool])
        const recentTools = a.output
          .filter(l => typeof l === "string" && l.startsWith("[tool] "))
          .slice(-5)
          .map(l => l.slice(7).replace(/\.\.\.$/, ""));
        return {
          id: a.id, name: a.name, role: a.role, status: a.status,
          currentTask: a.currentTask, tokensUsed: a.tokensUsed,
          elapsed: Date.now() - a.startedAt, recentTools,
        };
      });
    } catch {}
    json(200, { running, job, subAgents }); return true;
  }
  if (method === "POST" && url.pathname === "/api/cron/settings") {
    const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
    ctx.cronService.updateSettings(body);
    json(200, { ok: true, settings: ctx.cronService.getSettings() }); return true;
  }
  // Cron reports
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports$/)) {
    const id = url.pathname.split("/")[3];
    const { existsSync: exists, readdirSync } = await import("node:fs");
    const reportDir = (await import("node:path")).join(ctx.dataDir, "cron", "reports", id);
    if (!exists(reportDir)) { json(200, { reports: [] }); return true; }
    const files = readdirSync(reportDir).filter(f => f.endsWith(".md")).sort().reverse();
    json(200, { reports: files.map(f => ({ name: f, path: `/api/cron/${id}/reports/${f}` })) }); return true;
  }
  if (method === "GET" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports\/[^/]+\.md$/)) {
    const parts = url.pathname.split("/");
    const id = parts[3], file = parts[5];
    if (!/^[\w-]+\.md$/.test(file)) { json(400, { error: "Invalid file name" }); return true; }
    const { existsSync: exists, readFileSync: readF } = await import("node:fs");
    const reportPath = (await import("node:path")).join(ctx.dataDir, "cron", "reports", id, file);
    if (!exists(reportPath)) { json(404, { error: "Report not found" }); return true; }
    json(200, { content: readF(reportPath, "utf-8") }); return true;
  }
  // Delete a single report (removes from both .sax/cron/reports and workspace/missions mirror)
  if (method === "DELETE" && url.pathname.match(/^\/api\/cron\/[^/]+\/reports\/[^/]+\.md$/)) {
    const parts = url.pathname.split("/");
    const id = parts[3], file = parts[5];
    if (!/^[\w-]+\.md$/.test(file)) { json(400, { error: "Invalid file name" }); return true; }
    const { existsSync: exists, unlinkSync } = await import("node:fs");
    const path = await import("node:path");
    const job = ctx.cronService.get(id);
    const primary = path.join(ctx.dataDir, "cron", "reports", id, file);
    let deleted = 0;
    if (exists(primary)) { try { unlinkSync(primary); deleted++; } catch {} }
    if (job) {
      const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      const mirror = path.join(path.resolve(ctx.config.workspace), "missions", slug, file);
      if (exists(mirror)) { try { unlinkSync(mirror); deleted++; } catch {} }
    }
    json(200, { ok: true, deleted }); return true;
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
      const r = await fetch(`${getRuntimeConfig().xttsServerUrl}/voices/${voiceId}/preview`);
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
      try { const h = await fetch(`${getRuntimeConfig().xttsServerUrl}/health`, { signal: AbortSignal.timeout(1000) }); if (h.ok) { json(200, { ok: true, status: "already running" }); return true; } } catch {}
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
      const MAX_AUDIO_BYTES = getRuntimeConfig().maxAudioBytes;
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
    ctx.integrations.addIntegration(body as unknown as import("../integrations.js").IntegrationConfig);
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
    } catch (e) { json(200, { ok: false, error: (e as Error).message }); }
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
    const operatorEntry = ctx.rbac.listTokens().find(t => t.id === "operator-default");
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
  if (method === "POST" && url.pathname === "/api/auth/anthropic/setup-token") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const token = String((body as { token?: string }).token || "").trim();
      const { saveAnthropicSetupToken } = await import("../auth-anthropic.js");
      saveAnthropicSetupToken(token);
      json(200, { ok: true, method: "token" });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
    const { loadAnthropicTokens, isAnthropicTokenExpired } = await import("../auth-anthropic.js");
    const tokens = loadAnthropicTokens();
    let cliInstalled = false;
    try { const { execSync } = await import("node:child_process"); execSync("claude --version", { timeout: 5000, stdio: "pipe" }); cliInstalled = true; } catch {}
    json(200, { authenticated: !!tokens, method: tokens?.method || (tokens ? "oauth" : "none"), expired: isAnthropicTokenExpired(tokens), cliInstalled }); return true;
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
