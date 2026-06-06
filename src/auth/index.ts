import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { getAuthPath } from "../config.js";
import type { OAuthTokens } from "../types.js";
import { isCodexMirrorEnabled, warnMirrorDisabledOnce, mirrorImpl } from "./codex-mirror.js";
import { encryptAuthBlob, decryptAuthBlob } from "./storage.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth");

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

  let raw: string;
  try {
    raw = readFileSync(authPath, "utf-8");
  } catch (e) {
    logger.error(`[auth] FAILED to read ${authPath}: ${(e as Error).message} — treating as no-auth.`);
    return null;
  }

  // Decrypt-or-pass-through. Envelope → decrypt; legacy plaintext → keep
  // as-is and re-save encrypted below. Any other shape (tampered envelope,
  // wrong key, malformed JSON) throws — we surface it to the user and
  // return null so the chat path's "no auth, please log in" UX kicks in.
  let plaintext: string;
  let wasEncrypted: boolean;
  try {
    const result = decryptAuthBlob(raw, dirname(authPath));
    plaintext = result.plaintext;
    wasEncrypted = result.wasEncrypted;
  } catch (e) {
    logger.error(`[auth] FAILED to decrypt ${authPath}: ${(e as Error).message} — treating as no-auth. If this persists, delete the file and re-login.`);
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(plaintext);
  } catch (e) {
    // Loud on parse failure — used to be silent "// Corrupted file"
    // which hid a real failure mode (partial write, manual edit, disk
    // I/O error mid-read). Returning null without logging meant the
    // chat path saw "no token" and the user couldn't tell why.
    logger.error(`[auth] FAILED to parse ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
    return null;
  }

  const tokens = data as Partial<OAuthTokens>;
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
    // File exists, parsed, but missing required fields — treat as
    // corrupted-by-shape. Loud-log so future "I signed in but chat says
    // not authenticated" reports have a debuggable signal.
    logger.error(`[auth] ${authPath} parsed OK but missing required fields (accessToken/refreshToken/expiresAt) — treating as no-auth`);
    return null;
  }

  // Backwards-compat one-shot migration: any legacy plaintext file is
  // rewritten as an envelope on next load. No flag, no opt-in — the
  // user's tokens just stop being readable on a stolen disk image.
  if (!wasEncrypted) {
    try {
      saveTokens(tokens as OAuthTokens);
      logger.info(`[auth] ${authPath} migrated to encrypted-at-rest format.`);
    } catch (e) {
      // Migration failure isn't fatal — the tokens we just parsed are
      // still valid; the user can keep using them. They just stay
      // plaintext on disk until the next saveTokens succeeds.
      logger.warn(`[auth] Could not migrate ${authPath} to encrypted format: ${(e as Error).message}`);
    }
  }

  return tokens as OAuthTokens;
}

// Exported for tests. Real callers are inside this module (login + refresh);
// the gate test in auth.test.ts drives it directly to verify the env-var
// controls whether the Codex mirror runs.
export function saveTokens(tokens: OAuthTokens): void {
  const authPath = getAuthPath();
  const jsonString = JSON.stringify(tokens, null, 2);

  // Encrypt-at-rest. The plaintext JSON is wrapped in an AES-GCM
  // envelope keyed by the OS keychain (DPAPI / macOS Keychain /
  // libsecret). A stolen laptop or leaked disk image no longer hands
  // an attacker the user's live OAuth tokens — they also need the OS
  // keychain. If encryption fails (keychain unavailable, key wrong
  // length, etc.) we don't crash a successful login: log loud and
  // write plaintext as a degraded mode. keychain.ts always returns
  // *some* key (file-fallback as last resort), so this branch should
  // be rare in practice.
  let payload: string;
  try {
    payload = encryptAuthBlob(jsonString, dirname(authPath));
  } catch (e) {
    logger.warn(`[auth] CRITICAL: could not encrypt ${authPath}: ${(e as Error).message}. Falling back to PLAINTEXT on disk — your OAuth tokens are NOT protected at rest until the keychain becomes available.`);
    payload = jsonString;
  }

  // Atomic write. Without this, a crash or kill-9 mid-write leaves
  // auth.json half-written; next loadTokens parses partial JSON and
  // logs corruption — user thinks their saved auth vanished.
  const tmp = `${authPath}.tmp`;
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  // Bridge to the Codex CLI's own credential store, gated by
  // LAX_MIRROR_CODEX_AUTH. When enabled, every saveTokens (initial
  // login AND refresh) writes ~/.codex/auth.json so the CLI subprocess
  // used by build_app can authenticate without a separate `codex login`.
  // Default is OFF: the mirror doubles the on-disk credential surface,
  // so users opt in explicitly when they need build_app. With the gate
  // off we also skip the @openai/codex auto-install — no point pulling
  // a CLI we can't authenticate.
  if (isCodexMirrorEnabled()) {
    mirrorImpl.fn(tokens);
  } else {
    warnMirrorDisabledOnce();
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
          <html><body style="background:#0a0a0f;color:#c8d0e0;font-family:'Cascadia Code','Fira Code','Consolas',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center;background:linear-gradient(165deg,#131325,#0f0f18);border:1px solid #1a1a2e;border-radius:16px;padding:32px 48px;box-shadow:0 8px 60px rgba(0,0,0,.55),0 0 0 1px #30cccc88">
              <h1 style="color:#40f0f0;letter-spacing:2px;text-shadow:0 0 12px #30cccc88;margin:0 0 8px">Local Agent X</h1>
              <p style="margin:0">Authentication successful. <span style="color:#666680">You can close this tab.</span></p>
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
