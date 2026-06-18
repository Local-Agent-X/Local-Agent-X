import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, dirname } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { writeSecretFileAtomic } from "./secret-file.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth-xai");

/**
 * xAI Grok OAuth — SuperGrok / X Premium+ subscription access via PKCE flow
 * against accounts.x.ai. Bearer token is consumed as a standard API key on
 * https://api.x.ai/v1 (OpenAI-compat), so the OpenAI HTTP adapter consumes
 * it with zero transport changes.
 *
 * xAI quirks worth knowing:
 *   - /authorize MUST include `plan=generic`. accounts.x.ai rejects loopback
 *     OAuth from non-allowlisted clients otherwise.
 *   - Token exchange must ECHO `code_challenge` + `code_challenge_method`
 *     alongside the verifier. xAI re-validates the challenge at the token
 *     endpoint instead of relying purely on session state.
 *   - Standard SuperGrok subscribers can OAuth-login successfully but get
 *     HTTP 403 on inference. Documented in the Settings UI as the fallback
 *     path to a plain XAI_API_KEY.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REFRESH_SKEW_MS = 2 * 60 * 1000;

export interface XaiTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  provider: "xai";
}

function getAuthPath(): string {
  return join(getLaxDir(), "xai-auth.json");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

interface OidcEndpoints { authorizationEndpoint: string; tokenEndpoint: string; }

// xAI's apex is bare `x.ai`; accept any *.x.ai subdomain. Pin to https.
function validateOauthOrigin(endpoint: string, field: string): void {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new Error(`xAI OIDC discovery returned malformed ${field}: ${endpoint}`); }
  if (u.protocol !== "https:") throw new Error(`xAI OIDC discovery returned non-HTTPS ${field}: ${endpoint}`);
  const host = u.hostname.toLowerCase();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xAI OIDC discovery returned off-origin ${field}: ${endpoint}`);
  }
}

async function fetchOidcDiscovery(): Promise<OidcEndpoints> {
  const res = await fetch(DISCOVERY_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`xAI OIDC discovery failed (${res.status})`);
  const data = await res.json() as { authorization_endpoint?: string; token_endpoint?: string };
  const authorizationEndpoint = String(data.authorization_endpoint || "").trim();
  const tokenEndpoint = String(data.token_endpoint || "").trim();
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("xAI OIDC discovery missing endpoints");
  validateOauthOrigin(authorizationEndpoint, "authorization_endpoint");
  validateOauthOrigin(tokenEndpoint, "token_endpoint");
  return { authorizationEndpoint, tokenEndpoint };
}

export function loadXaiTokens(): XaiTokens | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    if (data.accessToken) return { ...data, provider: "xai" } as XaiTokens;
    logger.error(`[auth-xai] ${authPath} parsed but missing accessToken — treating as no-auth`);
  } catch (e) {
    logger.error(`[auth-xai] FAILED to parse ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
  }
  return null;
}

function saveXaiTokens(tokens: XaiTokens): void {
  const authPath = getAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  writeSecretFileAtomic(authPath, JSON.stringify(tokens, null, 2));
}

export function isXaiTokenExpired(tokens: XaiTokens | null): boolean {
  if (!tokens) return false;
  return !!tokens.expiresAt && Date.now() > tokens.expiresAt;
}

// ── In-flight login state ──
//
// Holds the PKCE verifier/challenge + state + chosen redirect URI between
// initiateXaiLogin() and either of:
//   (a) the loopback callback firing,
//   (b) the user manually pasting the code into the UI (fallback when the
//       browser can't reach our loopback — strict security extensions,
//       firewalled environments, or xAI's preflight "could not reach app"
//       page that hands the code over for manual exchange).
// One in-flight login at a time — a second initiate overwrites the first.
interface PendingXaiLogin {
  verifier: string;
  challenge: string;
  state: string;
  endpoints: OidcEndpoints;
  redirectUri: string;
  expiresAt: number;
}
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
let pendingXaiLogin: PendingXaiLogin | null = null;

// Shared token-exchange path used by both the loopback callback handler
// and the manual-paste endpoint. xAI re-validates code_challenge at the
// token step in addition to code_verifier — without it the server rejects
// with "code_challenge is required" despite a valid verifier.
async function performXaiTokenExchange(params: {
  code: string;
  endpoints: OidcEndpoints;
  redirectUri: string;
  verifier: string;
  challenge: string;
}): Promise<XaiTokens> {
  const tokenRes = await fetch(params.endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
      code_challenge: params.challenge,
      code_challenge_method: "S256",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`xAI token exchange failed (${tokenRes.status}): ${body}`);
  }
  const data = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - REFRESH_SKEW_MS : undefined,
    authorizationEndpoint: params.endpoints.authorizationEndpoint,
    tokenEndpoint: params.endpoints.tokenEndpoint,
    provider: "xai",
  };
}

// Manual fallback: user pastes the code from xAI's "could not reach app"
// page directly. Uses the verifier/challenge from the in-flight login.
// Caller must have started login (initiateXaiLogin) before this — without
// the saved verifier the token endpoint will reject the code.
export async function exchangeXaiCodeManually(code: string): Promise<void> {
  const trimmed = (code || "").trim();
  if (!trimmed) throw new Error("Paste the code from xAI first.");
  const pending = pendingXaiLogin;
  if (!pending) throw new Error("No xAI login in progress — click Sign In with xAI first.");
  if (pending.expiresAt < Date.now()) {
    pendingXaiLogin = null;
    throw new Error("Login session expired — click Sign In with xAI again.");
  }
  const tokens = await performXaiTokenExchange({
    code: trimmed,
    endpoints: pending.endpoints,
    redirectUri: pending.redirectUri,
    verifier: pending.verifier,
    challenge: pending.challenge,
  });
  saveXaiTokens(tokens);
  pendingXaiLogin = null;
  logger.info("[auth-xai] OAuth tokens saved (manual code paste)");
}

export function deleteXaiTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) unlinkSync(authPath);
}

// ── Token Refresh ──

let inflightRefresh: Promise<XaiTokens> | null = null;

export async function refreshXaiTokens(tokens: XaiTokens): Promise<XaiTokens> {
  if (!tokens.refreshToken) throw new Error("xAI refresh token missing — re-login required");
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const tokenEndpoint = tokens.tokenEndpoint || (await fetchOidcDiscovery()).tokenEndpoint;
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refreshToken!,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`xAI token refresh failed (${res.status}): ${body}`);
    }
    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const newTokens: XaiTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - REFRESH_SKEW_MS : undefined,
      authorizationEndpoint: tokens.authorizationEndpoint,
      tokenEndpoint,
      provider: "xai",
    };
    saveXaiTokens(newTokens);
    return newTokens;
  })().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

// invalid_grant/revoked/expired = xAI killed the refresh token (terminal — re-login
// needed). Network/timeout/5xx are transient; keep the token. Exported for tests.
export function isTerminalRefreshError(message: string): boolean {
  return /invalid_grant|invalid_token|\brevoked\b|token has expired|unauthorized_client/i.test(message);
}

export async function getXaiApiKey(): Promise<string | null> {
  let tokens = loadXaiTokens();
  if (!tokens) return null;
  if (isXaiTokenExpired(tokens) || (tokens.expiresAt && Date.now() > tokens.expiresAt - REFRESH_SKEW_MS)) {
    try { tokens = await refreshXaiTokens(tokens); }
    catch (e) {
      const msg = (e as Error).message;
      if (isTerminalRefreshError(msg)) {
        // Quarantine the dead token so status reads "not connected" honestly and
        // we stop hammering xAI with a revoked refresh token on every call.
        deleteXaiTokens();
        logger.warn(`[auth-xai] refresh token dead — cleared, re-login required: ${msg.slice(0, 160)}`);
      } else {
        logger.warn(`[auth-xai] refresh failed (transient — keeping token): ${msg.slice(0, 160)}`);
      }
      return null;
    }
  }
  return tokens.accessToken;
}

// ── OAuth Login Flow ──

// Bind the loopback callback, preferring `preferredPort` but falling back to an
// OS-assigned free port on EACCES/EADDRINUSE: on some Windows boxes the fixed port
// lands in a reserved range (Hyper-V/WSL/Docker) and listen() throws EACCES,
// crashing /login. RFC 8252 allows any 127.0.0.1 port, so the dynamic port is fine.
export function listenOnFreePort(server: Server, preferredPort: number, host: string): Promise<number> {
  const portOf = (): number => (server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("error", onError);
      if (err.code === "EACCES" || err.code === "EADDRINUSE") {
        logger.warn(`[auth-xai] callback port ${preferredPort} unavailable (${err.code}) — using an OS-assigned port`);
        server.once("error", reject);
        server.listen(0, host, () => resolve(portOf()));
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(preferredPort, host, () => resolve(portOf()));
  });
}

export async function initiateXaiLogin(): Promise<{ authUrl: string; promise: Promise<void> }> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");

  // Discovery first — the authorization_endpoint lives on accounts.x.ai,
  // not the auth.x.ai issuer host, so we can't guess it locally. If
  // discovery fails (offline, DNS/VPN blocked), surface the failure to the
  // caller before they ever see a "browser opening..." flash.
  const endpoints = await fetchOidcDiscovery();

  // Bind the callback server BEFORE building redirect_uri — the loopback redirect
  // must carry whatever port we actually got (the fixed port may be reserved).
  // The handler reads `redirectUri` only when the browser hits the callback, long
  // after it's assigned below.
  let redirectUri = "";
  let resolveLogin!: () => void;
  let rejectLogin!: (e: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", redirectUri || `http://${CALLBACK_HOST}`);
    if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end("Not found"); return; }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>Authentication failed</h2><p>${escapeHtml(String(error))}</p><p>You can close this window.</p></body></html>`);
      server.close();
      rejectLogin(new Error(`xAI OAuth error: ${error}`));
      return;
    }

    const stateValid = returnedState && returnedState.length === state.length &&
      timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
    if (!code || !stateValid) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>Invalid callback</h2><p>Missing code or state mismatch.</p></body></html>`);
      server.close();
      rejectLogin(new Error("xAI OAuth callback invalid (code missing or state mismatch)"));
      return;
    }

    try {
      const tokens = await performXaiTokenExchange({ code, endpoints, redirectUri, verifier, challenge });
      saveXaiTokens(tokens);
      // Clear pending state so a parallel manual paste doesn't double-exchange
      // (xAI invalidates auth codes on first use; the second call would 400).
      pendingXaiLogin = null;
      logger.info("[auth-xai] OAuth tokens saved");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:system-ui;background:#0a0a0f;color:#00ff41;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Connected to xAI Grok!</h2><p>You can close this window and return to Agent X.</p></div></body></html>`);
      server.close();
      resolveLogin();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>Token exchange failed</h2><p>${escapeHtml((e as Error).message)}</p></body></html>`);
      server.close();
      rejectLogin(e as Error);
    }
  });

  const boundPort = await listenOnFreePort(server, CALLBACK_PORT, CALLBACK_HOST);
  redirectUri = `http://${CALLBACK_HOST}:${boundPort}${CALLBACK_PATH}`;
  logger.info(`[auth-xai] Waiting for callback on ${CALLBACK_HOST}:${boundPort}...`);

  const authUrl = endpoints.authorizationEndpoint + "?" + new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "local-agent-x",
  }).toString();

  // Stash the PKCE + endpoint state (with the real port) so a parallel manual-code
  // paste can complete the exchange. Overwrites any prior in-flight login.
  pendingXaiLogin = {
    verifier, challenge, state, endpoints, redirectUri,
    expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
  };

  setTimeout(() => { server.close(); rejectLogin(new Error("xAI OAuth timeout")); }, 5 * 60 * 1000);

  return { authUrl, promise };
}
