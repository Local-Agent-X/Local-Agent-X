import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { execSync as _execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { npmAugmentedEnv } from "../../../anthropic-client/cli-path.js";

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

export const handleXaiAuthRoutes: RouteHandler = async (method, url, req, res, ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── xAI Grok OAuth (SuperGrok / X Premium+) ──
  if (method === "POST" && url.pathname === "/api/auth/xai/login") {
    try {
      const { initiateXaiLogin } = await import("../../../auth/xai.js");
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
      const { exchangeXaiCodeManually } = await import("../../../auth/xai.js");
      await exchangeXaiCodeManually(code);
      json(200, { ok: true });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/xai/logout") {
    try { const { deleteXaiTokens } = await import("../../../auth/xai.js"); deleteXaiTokens(); json(200, { ok: true }); }
    catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/xai/status") {
    try {
      const { loadXaiTokens, isXaiTokenExpired } = await import("../../../auth/xai.js");
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
  // ~/.grok/bin and updates the user's shell PATH. x.ai ships a separate
  // installer per OS: a bash script for macOS/Linux, a PowerShell script for
  // Windows. The bash flow dies on native Windows (no /bin/bash), so branch.
  if (method === "POST" && url.pathname === "/api/auth/xai/install-cli") {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const installCmd = process.platform === "win32"
        ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"`
        : "curl -fsSL https://x.ai/cli/install.sh | bash";
      const { stdout, stderr } = await promisify(exec)(installCmd, { timeout: 180_000 });
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

let grokCliLoginProc: import("node:child_process").ChildProcess | null = null;
