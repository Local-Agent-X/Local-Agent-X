import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { execSync as _execSync } from "node:child_process";
import { npmAugmentedEnv, resetNpmAugmentedEnvCache } from "../../../anthropic-client/cli-path.js";

const logger = createLogger("routes.bridges.auth");

export const handleAnthropicAuthRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "POST" && url.pathname === "/api/auth/anthropic/logout") {
    try { const { deleteAnthropicTokens } = await import("../../../auth/anthropic.js"); deleteAnthropicTokens(); json(200, { ok: true }); }
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
      const { saveAnthropicSetupToken } = await import("../../../auth/anthropic.js");
      saveAnthropicSetupToken(token);
      json(200, { ok: true, method: "token" });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "GET" && url.pathname === "/api/auth/anthropic/status") {
    const { loadAnthropicTokens, isAnthropicTokenExpired } = await import("../../../auth/anthropic.js");
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
      // The CLI is logged in when ~/.claude/.credentials.json (OAuth) or
      // config.json (account/key) is present — shared with /api/providers via
      // one helper so Settings and the chat picker never disagree.
      try {
        const { isAnthropicCliAuthenticated } = await import("../../../auth/anthropic.js");
        cliAuthenticated = isAnthropicCliAuthenticated();
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
    // Paste-the-code OAuth: build the same authorize URL the `claude` CLI uses
    // and hand it to the browser. The user pastes the resulting code back via
    // /cli-login-submit. We do NOT spawn the CLI here — a backgrounded CLI opens
    // the browser a second time and can never receive the code, which is the
    // dead-end this replaces.
    try {
      const { startAnthropicCliOAuth } = await import("../../../auth/anthropic.js");
      const { authUrl } = startAnthropicCliOAuth();
      json(200, { ok: true, authUrl });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/cli-login-submit") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const code = String((body as { code?: string }).code || "").trim();
      const { completeAnthropicCliOAuth } = await import("../../../auth/anthropic.js");
      await completeAnthropicCliOAuth(code);
      json(200, { ok: true, method: "cli-session" });
    } catch (e) { json(400, { error: safeErrorMessage(e) }); }
    return true;
  }
  if (method === "POST" && url.pathname === "/api/auth/anthropic/cli-login-cancel") {
    try { const { cancelAnthropicCliOAuth } = await import("../../../auth/anthropic.js"); cancelAnthropicCliOAuth(); } catch {}
    json(200, { ok: true }); return true;
  }

  return false;
};
