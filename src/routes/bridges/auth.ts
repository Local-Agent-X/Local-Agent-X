import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { createLogger } from "../../logger.js";
import { execSync as _execSync } from "node:child_process";
import { npmAugmentedEnv, resetNpmAugmentedEnvCache } from "../../anthropic-client/cli-path.js";

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
    try { _execSync("codex --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }); cliInstalled = true; } catch {}
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
      resetNpmAugmentedEnvCache(); // re-detect in case the prefix changed
      let version = "unknown";
      try { version = _execSync("codex --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }).toString().trim(); } catch {}
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
    let cliVersion: string | null = null;
    try {
      const out = _execSync("claude --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }).toString().trim();
      cliInstalled = true;
      // Output looks like "2.1.116 (Claude Code)" — keep just the semver head.
      const m = out.match(/(\d+\.\d+\.\d+)/);
      cliVersion = m ? m[1] : out;
      // Check if claude CLI has its own auth session by reading its config file.
      // If the CLI is logged in (oauthAccount present or API key set), builds/chat work
      // without us holding OAuth tokens.
      try {
        const { existsSync: exists, readFileSync: readF } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { join: j } = await import("node:path");
        // OAuth tokens live in .credentials.json; legacy API key / oauthAccount may
        // also appear in config.json. Either signal means the CLI is logged in.
        const credPath = j(homedir(), ".claude", ".credentials.json");
        if (exists(credPath)) {
          try {
            const cred = JSON.parse(readF(credPath, "utf-8"));
            if (cred?.claudeAiOauth?.accessToken || cred?.primaryApiKey) cliAuthenticated = true;
          } catch {}
        }
        if (!cliAuthenticated) {
          const configPath = j(homedir(), ".claude", "config.json");
          if (exists(configPath)) {
            try {
              const cfg = JSON.parse(readF(configPath, "utf-8"));
              if (cfg.oauthAccount || cfg.primaryApiKey || cfg.customApiKeyResponses) cliAuthenticated = true;
            } catch {}
          }
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
    json(200, { authenticated, method, expired: isAnthropicTokenExpired(tokens), cliInstalled, cliAuthenticated, cliVersion }); return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/update-cli") {
    // Reinstall at @latest. Same shell command as install-cli except pinned to
    // @latest so npm always reaches out for the newest release rather than
    // short-circuiting on a cached version. UI exposes this separately so
    // users can refresh without removing the package first.
    try {
      const before = (() => {
        try {
          return _execSync("claude --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }).toString().trim().match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
        } catch { return null; }
      })();
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("npm install -g @anthropic-ai/claude-code@latest", { timeout: 180_000 });
      resetNpmAugmentedEnvCache();
      let after = "unknown";
      try {
        const out = _execSync("claude --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }).toString().trim();
        after = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? out;
      } catch {}
      json(200, { ok: true, before, after, changed: before !== after, output: (stdout + stderr).slice(-500) });
    } catch (e) { json(500, { error: `Update failed: ${safeErrorMessage(e)}` }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/install-cli") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("npm install -g @anthropic-ai/claude-code", { timeout: 120_000 });
      resetNpmAugmentedEnvCache(); // re-detect in case the prefix changed
      let version = "unknown";
      try { version = _execSync("claude --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }).toString().trim(); } catch {}
      json(200, { ok: true, version, output: (stdout + stderr).slice(-500) });
    } catch (e) { json(500, { error: `Install failed: ${safeErrorMessage(e)}` }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/cli-login") {
    try {
      const { spawn } = await import("node:child_process");
      const env = npmAugmentedEnv();
      try { _execSync("claude --version", { timeout: 5000, stdio: "pipe", env }); }
      catch { json(400, { error: "Claude CLI not installed. Install it first." }); return true; }

      if (cliLoginProc && cliLoginProc.exitCode === null) {
        try { cliLoginProc.kill(); } catch {}
      }
      const proc = spawn("claude", ["auth", "login", "--claudeai"], { shell: true, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true, env });
      cliLoginProc = proc;
      proc.on("exit", code => { logger.info(`[cli-login] claude auth login exited (${code})`); if (cliLoginProc === proc) cliLoginProc = null; });

      const urlRegex = /https?:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com|anthropic\.com)\/[^\s'"<>]+/i;
      let captured = "";
      let buffered = "";
      const stripAnsi = (s: string) => s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      const onChunk = (chunk: Buffer) => {
        const clean = stripAnsi(chunk.toString());
        buffered += clean;
        if (!captured) {
          const m = buffered.match(urlRegex);
          if (m) captured = m[0].replace(/[)\].,;]+$/, "");
        }
        logger.info(`[cli-login] output: ${clean.slice(0, 400).replace(/\n/g, "\\n")}`);
      };
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);

      const deadline = Date.now() + 8000;
      while (!captured && Date.now() < deadline && proc.exitCode === null) await new Promise(r => setTimeout(r, 100));

      if (captured) {
        logger.info(`[cli-login] captured OAuth URL`);
        json(200, { ok: true, authUrl: captured });
      } else {
        try { proc.kill(); } catch {}
        json(500, { error: "Could not capture login URL from `claude login` within 8s. Run `claude login` in a terminal instead." });
      }
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/cli-login-cancel") {
    if (cliLoginProc && cliLoginProc.exitCode === null) {
      try { cliLoginProc.kill(); } catch {}
      cliLoginProc = null;
    }
    json(200, { ok: true }); return true;
  }

  return false;
};

let cliLoginProc: import("node:child_process").ChildProcess | null = null;
