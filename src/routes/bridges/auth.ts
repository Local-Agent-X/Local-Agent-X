import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.bridges.auth");

export const handleAuthRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Auth ──
  if (method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const { initiateOAuthLogin } = await import("../../auth.js");
      const { authUrl, promise } = initiateOAuthLogin();
      promise.then(() => logger.info("OAuth login completed")).catch((e) => logger.warn("OAuth login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      const { getAuthPath } = await import("../../config.js");
      const { unlinkSync, existsSync } = await import("node:fs");
      const authPath = getAuthPath();
      if (existsSync(authPath)) unlinkSync(authPath);
      json(200, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/status") {
    const { loadTokens } = await import("../../auth.js");
    const tokens = loadTokens();
    const operatorEntry = ctx.rbac.listTokens().find(t => t.id === "operator-default");
    const expiresAt = operatorEntry?.expiresAt || null;
    const daysRemaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    let cliInstalled = false;
    try { const { execSync } = await import("node:child_process"); execSync("codex --version", { timeout: 5000, stdio: "pipe" }); cliInstalled = true; } catch {}
    json(200, {
      authenticated: !!tokens || !!ctx.config.openaiApiKey,
      method: ctx.config.openaiApiKey ? "api_key" : tokens ? "oauth" : "none",
      tokenExpiresAt: expiresAt, tokenDaysRemaining: daysRemaining,
      tokenExpiringSoon: daysRemaining !== null && daysRemaining <= 7,
      cliInstalled,
    }); return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/openai/install-cli") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("npm install -g @openai/codex", { timeout: 180_000 });
      let version = "unknown";
      try { const { execSync } = await import("node:child_process"); version = execSync("codex --version", { timeout: 5000, stdio: "pipe" }).toString().trim(); } catch {}
      json(200, { ok: true, version, output: (stdout + stderr).slice(-500) });
    } catch (e) { json(500, { error: `Install failed: ${safeErrorMessage(e)}` }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/login") {
    try {
      const { initiateAnthropicLogin } = await import("../../auth-anthropic.js");
      const { authUrl, promise } = initiateAnthropicLogin();
      promise.then(() => logger.info("Anthropic login completed")).catch((e) => logger.warn("Anthropic login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
    try { const { deleteAnthropicTokens } = await import("../../auth-anthropic.js"); deleteAnthropicTokens(); json(200, { ok: true }); }
    catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/setup-token") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const token = String((body as { token?: string }).token || "").trim();
      const { saveAnthropicSetupToken } = await import("../../auth-anthropic.js");
      saveAnthropicSetupToken(token);
      json(200, { ok: true, method: "token" });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
    const { loadAnthropicTokens, isAnthropicTokenExpired } = await import("../../auth-anthropic.js");
    const tokens = loadAnthropicTokens();
    let cliInstalled = false;
    let cliAuthenticated = false;
    try {
      const { execSync } = await import("node:child_process");
      execSync("claude --version", { timeout: 5000, stdio: "pipe" });
      cliInstalled = true;
      // Check if claude CLI has its own auth session by reading its config file.
      // If the CLI is logged in (oauthAccount present or API key set), builds/chat work
      // without us holding OAuth tokens.
      try {
        const { existsSync: exists, readFileSync: readF } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { join: j } = await import("node:path");
        const configPath = j(homedir(), ".claude", "config.json");
        if (exists(configPath)) {
          const cfg = JSON.parse(readF(configPath, "utf-8"));
          cliAuthenticated = !!(cfg.oauthAccount || cfg.primaryApiKey || cfg.customApiKeyResponses);
        }
      } catch {}
    } catch {}
    // Treat as authenticated if we have valid tokens OR the CLI itself is logged in
    const hasValidTokens = !!tokens && !isAnthropicTokenExpired(tokens);
    const authenticated = hasValidTokens || cliAuthenticated;
    // Method reflects the path actually being used at runtime:
    // - If our tokens are still valid, the app uses them
    // - Otherwise we spawn the CLI which uses its own login
    const method = hasValidTokens ? (tokens?.method || "oauth") : cliAuthenticated ? "cli-session" : "none";
    json(200, { authenticated, method, expired: isAnthropicTokenExpired(tokens), cliInstalled, cliAuthenticated }); return true;
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
