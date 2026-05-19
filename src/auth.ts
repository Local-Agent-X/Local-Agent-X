import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getAuthPath } from "./config.js";
import type { OAuthTokens } from "./types.js";

import { createLogger } from "./logger.js";
const logger = createLogger("auth");

// ── Codex CLI auto-install on first OAuth success ──
// Yesterday's bridge (commit 718c13d) writes tokens to ~/.codex/auth.json so
// the CLI is *authenticated* once installed. But the bridge assumed CLI was
// already on PATH — fresh users who only ran the LAX installer don't have
// the global @openai/codex package. build_app then fails with "codex CLI
// not available". This closes the gap: after the bridge writes auth.json,
// check for the codex binary; if missing, install it (async, non-blocking).
// One install per process via the in-flight Promise gate so we don't race.
let _codexCliInstallInFlight: Promise<void> | null = null;
function ensureCodexCliInstalled(): void {
  if (_codexCliInstallInFlight) return;
  // Fast check: is `codex --version` on PATH?
  try {
    const check = spawnSync("codex", ["--version"], { stdio: "ignore", shell: process.platform === "win32", timeout: 3000 });
    if (check.status === 0) return; // already installed
  } catch { /* fall through to install */ }
  logger.info("[auth] Codex CLI not on PATH — installing @openai/codex globally (background)…");
  _codexCliInstallInFlight = new Promise<void>((resolve) => {
    const proc = spawn("npm", ["install", "-g", "@openai/codex"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    proc.on("exit", (code) => {
      if (code === 0) logger.info("[auth] Codex CLI installed — build_app is now available");
      else logger.warn(`[auth] Codex CLI install exited with ${code}. Install manually if needed: npm install -g @openai/codex`);
      _codexCliInstallInFlight = null;
      resolve();
    });
    proc.on("error", (e) => {
      logger.warn(`[auth] Codex CLI install spawn failed: ${e.message}. Install manually: npm install -g @openai/codex`);
      _codexCliInstallInFlight = null;
      resolve();
    });
  });
}

// OpenAI Codex OAuth endpoints (shared public client ID for CLI tools)
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Token Storage ──

export function loadTokens(): OAuthTokens | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    if (data.accessToken && data.refreshToken && data.expiresAt) {
      return data as OAuthTokens;
    }
    // File exists, parsed, but missing required fields — treat as
    // corrupted-by-shape. Loud-log so future "I signed in but chat says
    // not authenticated" reports have a debuggable signal.
    logger.error(`[auth] ${authPath} parsed OK but missing required fields (accessToken/refreshToken/expiresAt) — treating as no-auth`);
  } catch (e) {
    // Loud on parse failure — used to be silent "// Corrupted file"
    // which hid a real failure mode (partial write, manual edit, disk
    // I/O error mid-read). Returning null without logging meant the
    // chat path saw "no token" and the user couldn't tell why.
    logger.error(`[auth] FAILED to parse ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
  }
  return null;
}

function saveTokens(tokens: OAuthTokens): void {
  const authPath = getAuthPath();
  // Atomic write. Without this, a crash or kill-9 mid-write leaves
  // auth.json half-written; next loadTokens parses partial JSON and
  // logs corruption — user thinks their saved auth vanished.
  const tmp = `${authPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  // Bridge to the Codex CLI's own credential store. Without this,
  // LAX's "Sign in with OpenAI" left ~/.codex/auth.json missing so
  // build_app's subprocess 401'd at the WebSocket layer with no
  // path back for the user except running `codex login` separately.
  // The bridge fires on every successful saveTokens (initial login
  // AND refresh), keeping the two stores in lockstep automatically.
  mirrorToCodexCli(tokens);
}

/**
 * Decode a JWT's payload without verifying the signature. We don't
 * need verification — we got the token from a trusted endpoint over
 * TLS and we're just reading a claim, not authenticating anyone with
 * it. Returns null on any parse failure (malformed JWT, base64 error,
 * non-JSON payload).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch { return null; }
}

/**
 * Pull the ChatGPT account_id claim out of the id_token. Tries the
 * standard OpenAI claim shapes (we don't have a typed schema for this
 * — discovered the field empirically from a real ~/.codex/auth.json).
 * Returns null if no recognizable claim is present.
 */
function extractAccountId(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  // Direct top-level keys seen in OpenAI ID tokens
  for (const k of ["chatgpt_account_id", "account_id", "https://api.openai.com/auth/chatgpt_account_id"]) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Nested under https://api.openai.com/auth claim namespace
  const auth = payload["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const a = auth as Record<string, unknown>;
    for (const k of ["chatgpt_account_id", "account_id"]) {
      const v = a[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
}

/**
 * Write a mirror of LAX's OAuth tokens to ~/.codex/auth.json in the
 * exact shape the Codex CLI expects. Format learned from a working
 * ~/.codex/auth.json captured after the user signed in via the new
 * "Sign in via Codex CLI" button (commit b25b632):
 *
 *   {
 *     "auth_mode": "chatgpt",
 *     "OPENAI_API_KEY": null,
 *     "tokens": {
 *       "id_token": "<jwt>",
 *       "access_token": "<jwt>",
 *       "refresh_token": "...",
 *       "account_id": "<uuid>"
 *     },
 *     "last_refresh": "ISO 8601"
 *   }
 *
 * Atomic write (tmp + rename). Logs and continues on any failure —
 * the LAX-side auth.json is the source of truth; this mirror is a
 * convenience for the CLI subprocess and shouldn't crash the chat
 * path if the file write fails (e.g. permissions on ~/.codex/).
 */
function mirrorToCodexCli(tokens: OAuthTokens): void {
  if (!tokens.idToken) {
    // Pre-bridge installs / older saved tokens won't have id_token.
    // We don't fail loudly here — the next refresh (triggered within
    // 5min of the next chat that uses the token) will populate idToken
    // and the bridge will fire then. Log once so the gap is visible.
    logger.warn("[auth] saveTokens called without id_token — Codex CLI bridge skipped. The CLI will pick up tokens on the next refresh.");
    return;
  }
  const codexPath = join(homedir(), ".codex", "auth.json");
  const accountId = tokens.accountId ?? extractAccountId(tokens.idToken) ?? "";
  const codexAuth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  const tmp = `${codexPath}.tmp`;
  try {
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(codexAuth, null, 2), { mode: 0o600 });
    renameSync(tmp, codexPath);
    logger.info(`[auth] mirrored tokens to ${codexPath} (Codex CLI bridge)`);
    // Fire-and-forget: if codex binary isn't on PATH, install it. Bridge
    // write succeeded means we have valid tokens — useless without the
    // CLI to consume them. Non-blocking so token-save stays fast.
    ensureCodexCliInstalled();
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    logger.warn(`[auth] Codex CLI bridge write failed: ${(e as Error).message}`);
  }
}

// ── Token Refresh ──

// Coalesce concurrent refresh attempts into a single in-flight promise.
// Without this, two near-simultaneous getApiKey() callers (e.g. two chat
// turns landing within the 5min refresh window, or the proactive timer
// firing while a lazy call is also in progress) each call refresh —
// the second call carries a now-rotated refresh_token and OpenAI rejects
// it with 401. Symptom: one chat works, another fails with cryptic
// "Token refresh failed (401)" — pure timing race, painful to debug.
// All callers go through this public `refreshTokens`; coalescing is
// internal so the call sites don't need to learn the pattern.
let inflightRefresh: Promise<OAuthTokens> | null = null;

export async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      id_token?: string;
    };

    // Preserve idToken/accountId across refreshes: prefer the value the
    // refresh response just returned (fresh id_token), fall back to
    // the previous in-disk values so a refresh that doesn't return
    // id_token doesn't blank out the Codex bridge.
    const newIdToken = data.id_token ?? tokens.idToken;
    const newTokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      ...(newIdToken ? { idToken: newIdToken } : {}),
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    };

    saveTokens(newTokens);
    return newTokens;
  })().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

// ── Get Valid API Key ──

export async function getApiKey(configApiKey?: string): Promise<string> {
  // Direct API key takes priority
  if (configApiKey) return configApiKey;

  // Try OAuth tokens
  let tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "No API key or OAuth tokens found. Set OPENAI_API_KEY or run the OAuth login flow."
    );
  }

  // Refresh if expiring within 5 minutes. Concurrent calls are coalesced
  // inside refreshTokens — see the inflightRefresh promise cache there.
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  if (Date.now() > tokens.expiresAt - REFRESH_MARGIN_MS) {
    logger.info("[auth] Refreshing OAuth tokens...");
    tokens = await refreshTokens(tokens);
  }

  return tokens.accessToken;
}

// ── OAuth Login Flow ──

// Pending login state (so the callback server can complete the exchange)
let pendingLogin: { verifier: string; resolve: (t: OAuthTokens) => void; reject: (e: Error) => void } | null = null;
let callbackServer: ReturnType<typeof createServer> | null = null;
let callbackTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initiate OAuth flow: generates PKCE, starts callback server, returns the auth URL.
 * Does NOT block — call this from an API endpoint and return the URL to the browser.
 */
export function initiateOAuthLogin(): { authUrl: string; promise: Promise<OAuthTokens> } {
  // Clean up any prior pending login
  if (callbackTimeout) clearTimeout(callbackTimeout);
  if (callbackServer) try { callbackServer.close(); } catch {}

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "openid profile email offline_access");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");

  const promise = new Promise<OAuthTokens>((resolve, reject) => {
    pendingLogin = { verifier, resolve, reject };

    callbackTimeout = setTimeout(() => {
      if (callbackServer) try { callbackServer.close(); } catch {}
      pendingLogin = null;
      reject(new Error("OAuth login timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    callbackServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }
      // Validate state parameter to prevent CSRF
      const stateValid = returnedState && returnedState.length === state.length &&
        timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
      if (!stateValid) {
        res.writeHead(400);
        res.end("Invalid state parameter — possible CSRF attack");
        logger.warn("[auth] OAuth state mismatch! Expected:", state.slice(0, 8) + "...", "Got:", returnedState?.slice(0, 8) + "...");
        return;
      }

      if (!pendingLogin) {
        res.writeHead(400);
        res.end("No pending login");
        return;
      }

      try {
        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
            code_verifier: pendingLogin.verifier,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
        }

        const data = (await tokenRes.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
          id_token?: string;
        };

        const tokens: OAuthTokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000,
          ...(data.id_token ? { idToken: data.id_token } : {}),
        };

        saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="background:#0a0a0f;color:#00ff41;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <h1>Local Agent X</h1>
              <p>Authentication successful. You can close this tab.</p>
            </div>
          </body></html>
        `);

        if (callbackTimeout) clearTimeout(callbackTimeout);
        callbackServer!.close();
        callbackServer = null;
        pendingLogin.resolve(tokens);
        pendingLogin = null;
      } catch (err) {
        res.writeHead(500);
        res.end("Token exchange failed");
        if (callbackTimeout) clearTimeout(callbackTimeout);
        callbackServer!.close();
        callbackServer = null;
        pendingLogin?.reject(err as Error);
        pendingLogin = null;
      }
    });

    callbackServer.listen(CALLBACK_PORT, "127.0.0.1", () => {
      logger.info(`[auth] Waiting for OAuth callback on port ${CALLBACK_PORT}...`);
    });
  });

  return { authUrl: authUrl.toString(), promise };
}

/**
 * Legacy blocking login (for CLI --login flag).
 */
export async function startOAuthLogin(): Promise<OAuthTokens> {
  const { authUrl, promise } = initiateOAuthLogin();

  logger.info(`\n[auth] Open this URL in your browser:\n\n  ${authUrl}\n`);

  const { execFile } = await import("node:child_process");
  const openCmd =
    process.platform === "win32"
      ? "start"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  if (process.platform === "win32") {
    // 'start' is a cmd builtin, needs shell — but URL is safe (built from constants + PKCE)
    execFile("cmd", ["/c", "start", "", authUrl]);
  } else {
    execFile(openCmd, [authUrl]);
  }

  return promise;
}
