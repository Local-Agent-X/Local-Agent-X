import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { execSync as _execSync } from "node:child_process";
import { npmAugmentedEnv, resetNpmAugmentedEnvCache } from "../../../anthropic-client/cli-path.js";

const logger = createLogger("routes.bridges.auth");

export const handleCoreAuthRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── Auth ──
  if (method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const { initiateOAuthLogin } = await import("../../../auth/index.js");
      const { authUrl, promise } = initiateOAuthLogin();
      promise.then(() => logger.info("OAuth login completed")).catch((e) => logger.warn("OAuth login failed:", e.message));
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    try {
      const { getAuthPath } = await import("../../../config.js");
      const { unlinkSync, existsSync } = await import("node:fs");
      const authPath = getAuthPath();
      if (existsSync(authPath)) unlinkSync(authPath);
      json(200, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/status") {
    const { loadTokens } = await import("../../../auth/index.js");
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

  return false;
};

let codexCliLoginProc: import("node:child_process").ChildProcess | null = null;
