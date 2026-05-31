import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../server-utils.js";
import { createLogger } from "../../logger.js";
import { execSync as _execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { npmAugmentedEnv, resetNpmAugmentedEnvCache } from "../../anthropic-client/cli-path.js";

const logger = createLogger("routes.bridges.auth");

// Grok Build CLI (`grok`) installs to ~/.grok/bin, which is NOT on the
// npm-augmented PATH (it isn't an npm global). Prepend it so the version
// check and the spawned `grok login` resolve the binary.
function grokAugmentedEnv(): NodeJS.ProcessEnv {
  const env = { ...npmAugmentedEnv() };
  const sep = process.platform === "win32" ? ";" : ":";
  env.PATH = `${join(homedir(), ".grok", "bin")}${sep}${env.PATH || ""}`;
  return env;
}

export const handleAuthRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Auth ──
  if (method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const { initiateOAuthLogin } = await import("../../auth/index.js");
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
    const { loadTokens } = await import("../../auth/index.js");
    const tokens = loadTokens();
    const operatorEntry = ctx.rbac.listTokens().find(t => t.id === "operator-default");
    const expiresAt = operatorEntry?.expiresAt || null;
    const daysRemaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    let cliInstalled = false;
    try { _execSync("codex --version", { timeout: 5000, stdio: "pipe", env: npmAugmentedEnv() }); cliInstalled = true; } catch {}
    // Codex CLI auth is SEPARATE from LAX's ~/.lax/auth.json. The CLI has
    // its own credential store at ~/.codex/auth.json — written only by
    // `codex login`, NOT by LAX's "Sign in with OpenAI" button. We were
    // reporting cliInstalled and the UI rendered a green "ready" badge,
    // but the CLI subprocess would 401 on every build_app call because
    // ~/.codex/auth.json didn't exist. The user calls this "the UI lying"
    // and they're right. Separate the two concepts in the response so
    // the badge can show "installed but not signed in" as a distinct
    // state with an actionable fix-button.
    let cliAuthenticated = false;
    if (cliInstalled) {
      try {
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        cliAuthenticated = existsSync(join(homedir(), ".codex", "auth.json"));
      } catch { /* leave cliAuthenticated=false on any fs error */ }
    }
    json(200, {
      authenticated: !!tokens || !!ctx.config.openaiApiKey,
      method: ctx.config.openaiApiKey ? "api_key" : tokens ? "oauth" : "none",
      tokenExpiresAt: expiresAt, tokenDaysRemaining: daysRemaining,
      tokenExpiringSoon: daysRemaining !== null && daysRemaining <= 7,
      cliInstalled,
      cliAuthenticated,
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
      const { initiateAnthropicLogin } = await import("../../auth/anthropic.js");
      const { authUrl, promise } = initiateAnthropicLogin();
      promise.then(() => logger.info("Anthropic login completed")).catch((e) => logger.warn("Anthropic login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
    try { const { deleteAnthropicTokens } = await import("../../auth/anthropic.js"); deleteAnthropicTokens(); json(200, { ok: true }); }
    catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/cli-logout") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("claude auth logout", {
        timeout: 15_000,
        env: npmAugmentedEnv(),
      });
      json(200, { ok: true, output: (stdout + stderr).slice(-300) });
    } catch (e) { json(500, { error: `CLI logout failed: ${safeErrorMessage(e)}` }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/setup-token") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const token = String((body as { token?: string }).token || "").trim();
      const { saveAnthropicSetupToken } = await import("../../auth/anthropic.js");
      saveAnthropicSetupToken(token);
      json(200, { ok: true, method: "token" });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
    const { loadAnthropicTokens, isAnthropicTokenExpired } = await import("../../auth/anthropic.js");
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
  // Mirror of /api/auth/anthropic/cli-login for the Codex CLI. The Codex
  // CLI has its own credential store at ~/.codex/auth.json — written
  // only when the user runs `codex login`, NOT by LAX's "Sign in with
  // OpenAI" button (that's a separate OAuth flow that writes
  // ~/.lax/auth.json). User caught the UI lying about CLI readiness
  // (7900fc4); this route lets the Settings panel actually trigger the
  // CLI login without making the user open Terminal.
  if (method === "POST" && url.pathname === "/api/auth/openai/cli-login") {
    try {
      const { spawn } = await import("node:child_process");
      const env = npmAugmentedEnv();
      try { _execSync("codex --version", { timeout: 5000, stdio: "pipe", env }); }
      catch { json(400, { error: "Codex CLI not installed. Install it first." }); return true; }

      if (codexCliLoginProc && codexCliLoginProc.exitCode === null) {
        try { codexCliLoginProc.kill(); } catch {}
      }
      // --device-auth prints a verification URL + code; the user opens
      // the URL in their existing browser, types the code, and the CLI
      // completes the flow + writes ~/.codex/auth.json. Avoids the
      // browser-spawn dance that some CLIs use, which doesn't work
      // cleanly when LAX spawns the process from a non-interactive
      // parent.
      const proc = spawn("codex", ["login"], { shell: true, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true, env });
      codexCliLoginProc = proc;
      proc.on("exit", code => { logger.info(`[cli-login] codex login exited (${code})`); if (codexCliLoginProc === proc) codexCliLoginProc = null; });

      // OpenAI OAuth URLs we expect codex to print. Broad enough to cover
      // chat.openai.com, platform.openai.com, auth.openai.com, and the
      // chatgpt.com host the subscription flow uses.
      const urlRegex = /https?:\/\/(?:auth\.openai\.com|platform\.openai\.com|chat\.openai\.com|chatgpt\.com|openai\.com)\/[^\s'"<>]+/i;
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
        logger.info(`[cli-login] codex output: ${clean.slice(0, 400).replace(/\n/g, "\\n")}`);
      };
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);

      const deadline = Date.now() + 8000;
      while (!captured && Date.now() < deadline && proc.exitCode === null) await new Promise(r => setTimeout(r, 100));

      if (captured) {
        logger.info(`[cli-login] captured OpenAI OAuth URL`);
        json(200, { ok: true, authUrl: captured });
      } else {
        try { proc.kill(); } catch {}
        json(500, { error: "Could not capture login URL from `codex login` within 8s. Run `codex login` in a terminal instead." });
      }
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/openai/cli-login-cancel") {
    if (codexCliLoginProc && codexCliLoginProc.exitCode === null) {
      try { codexCliLoginProc.kill(); } catch {}
      codexCliLoginProc = null;
    }
    json(200, { ok: true }); return true;
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

  // ── xAI Grok OAuth (SuperGrok / X Premium+) ──
  if (method === "POST" && url.pathname === "/api/auth/xai/login") {
    try {
      const { initiateXaiLogin } = await import("../../auth/xai.js");
      const { authUrl, promise } = await initiateXaiLogin();
      promise.then(() => logger.info("xAI login completed")).catch((e) => logger.warn("xAI login failed:", e.message));
      // Open in the system browser from the server process. The renderer's
      // window.open path is unreliable in the Electron wrapper for long URLs
      // with `+`-encoded scopes (Codex flow happens to work, xAI doesn't —
      // Chromium silently drops the call before setWindowOpenHandler fires).
      // Launching from Node bypasses all of that.
      let opened = false;
      try {
        const { execFile } = await import("node:child_process");
        let child;
        if (process.platform === "win32") {
          // rundll32 + url.dll passes the URL via argv directly to the
          // FileProtocolHandler API — no cmd, no shell, no `&` parsing.
          // `cmd /c start "" <url>` truncates the URL at the first `&`
          // because cmd reads `&` as a command separator.
          child = execFile("rundll32.exe", ["url.dll,FileProtocolHandler", authUrl]);
        } else if (process.platform === "darwin") {
          child = execFile("open", [authUrl]);
        } else {
          child = execFile("xdg-open", [authUrl]);
        }
        // execFile is fire-and-forget: a synchronous return does NOT prove the
        // browser opened. Spawn failures (ENOENT) — and on some Windows setups
        // rundll32 simply no-ops — surface asynchronously via the 'error'
        // event, AFTER this response is already sent. So `opened` is only a
        // best-effort hint; the renderer ALWAYS shows a clickable fallback
        // link regardless (settings-xai.js showXaiOpenFallback). The listener
        // also prevents an async 'error' from becoming an unhandled event.
        child.on("error", (e) => logger.warn(`[auth-xai] system-browser launch failed (async): ${e.message}`));
        opened = true;
      } catch (e) { logger.warn(`[auth-xai] system-browser launch failed: ${(e as Error).message}`); }
      json(200, { ok: true, authUrl, opened });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/xai/exchange-code") {
    try {
      const body = await safeParseBody(req);
      const code = typeof body?.code === "string" ? body.code : "";
      const { exchangeXaiCodeManually } = await import("../../auth/xai.js");
      await exchangeXaiCodeManually(code);
      json(200, { ok: true });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/xai/logout") {
    try { const { deleteXaiTokens } = await import("../../auth/xai.js"); deleteXaiTokens(); json(200, { ok: true }); }
    catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/xai/status") {
    try {
      const { loadXaiTokens, isXaiTokenExpired } = await import("../../auth/xai.js");
      const tokens = loadXaiTokens();
      const hasApiKey = ctx.secretsStore.has("XAI_API_KEY");
      const hasOAuth = !!tokens;
      const expired = isXaiTokenExpired(tokens);
      const authenticated = (hasOAuth && !expired) || hasApiKey;
      // method = which path resolve-provider would pick. OAuth wins when both
      // are configured (uses subscription quota instead of API spend).
      const method = hasOAuth && !expired ? "oauth" : hasApiKey ? "api_key" : "none";
      // Grok Build CLI is a SEPARATE credential from the OAuth above (same
      // distinction as Codex/Claude): the `grok` binary signs into its own
      // store at ~/.grok/auth.json via `grok login`, which is what the
      // self_edit surgeon reads. Surface install + sign-in as distinct states.
      let cliInstalled = false;
      try { _execSync("grok --version", { timeout: 5000, stdio: "pipe", env: grokAugmentedEnv() }); cliInstalled = true; } catch {}
      let cliAuthenticated = false;
      if (cliInstalled) {
        try { const { existsSync } = await import("node:fs"); cliAuthenticated = existsSync(join(homedir(), ".grok", "auth.json")); }
        catch { /* leave cliAuthenticated=false on any fs error */ }
      }
      json(200, { authenticated, method, hasOAuth, hasApiKey, expired, cliInstalled, cliAuthenticated });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  // Grok Build CLI install — ships via x.ai's install script, NOT npm (so it
  // can't reuse the openai/anthropic npm-install routes). Drops the binary in
  // ~/.grok/bin and updates the user's shell PATH.
  if (method === "POST" && url.pathname === "/api/auth/xai/install-cli") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout, stderr } = await promisify(exec)("curl -fsSL https://x.ai/cli/install.sh | bash", { timeout: 180_000 });
      let version = "unknown";
      try { version = _execSync("grok --version", { timeout: 5000, stdio: "pipe", env: grokAugmentedEnv() }).toString().trim(); } catch {}
      json(200, { ok: true, version, output: (stdout + stderr).slice(-500) });
    } catch (e) { json(500, { error: `Install failed: ${safeErrorMessage(e)}` }); }
    return true;
  }
  // Mirror of /api/auth/openai/cli-login for the Grok Build CLI. The `grok`
  // binary has its own credential store at ~/.grok/auth.json — written by
  // `grok login`, NOT by LAX's xAI OAuth button above (that writes
  // ~/.lax/xai-auth.json for LAX's own loop). This signs in the CLI so the
  // self_edit surgeon can spawn `grok` on the user's SuperGrok / X Premium+
  // subscription. --device-auth prints a verification URL we capture and
  // hand to the UI — the headless-safe flow (no browser-spawn dependency).
  if (method === "POST" && url.pathname === "/api/auth/xai/cli-login") {
    try {
      const { spawn } = await import("node:child_process");
      const env = grokAugmentedEnv();
      try { _execSync("grok --version", { timeout: 5000, stdio: "pipe", env }); }
      catch { json(400, { error: "Grok Build CLI not installed. Install it first." }); return true; }

      if (grokCliLoginProc && grokCliLoginProc.exitCode === null) {
        try { grokCliLoginProc.kill(); } catch {}
      }
      const proc = spawn("grok", ["login", "--device-auth"], { shell: true, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true, env });
      grokCliLoginProc = proc;
      proc.on("exit", code => { logger.info(`[cli-login] grok login exited (${code})`); if (grokCliLoginProc === proc) grokCliLoginProc = null; });

      // xAI device-auth URL, e.g. https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX
      const urlRegex = /https?:\/\/(?:accounts\.x\.ai|auth\.x\.ai|x\.ai)\/[^\s'"<>]+/i;
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
        logger.info(`[cli-login] grok output: ${clean.slice(0, 400).replace(/\n/g, "\\n")}`);
      };
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);

      const deadline = Date.now() + 8000;
      while (!captured && Date.now() < deadline && proc.exitCode === null) await new Promise(r => setTimeout(r, 100));

      if (captured) {
        logger.info(`[cli-login] captured xAI device-auth URL`);
        json(200, { ok: true, authUrl: captured });
      } else {
        try { proc.kill(); } catch {}
        json(500, { error: "Could not capture login URL from `grok login --device-auth` within 8s. Run `grok login` in a terminal instead." });
      }
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/xai/cli-login-cancel") {
    if (grokCliLoginProc && grokCliLoginProc.exitCode === null) {
      try { grokCliLoginProc.kill(); } catch {}
      grokCliLoginProc = null;
    }
    json(200, { ok: true }); return true;
  }

  return false;
};

let cliLoginProc: import("node:child_process").ChildProcess | null = null;
let codexCliLoginProc: import("node:child_process").ChildProcess | null = null;
let grokCliLoginProc: import("node:child_process").ChildProcess | null = null;
