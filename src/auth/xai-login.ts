import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createLogger } from "../logger.js";
import {
  CLIENT_ID,
  SCOPE,
  fetchOidcDiscovery,
  saveXaiTokens,
  type XaiTokens,
  type OidcEndpoints,
} from "./xai.js";

const logger = createLogger("auth-xai");

/**
 * xAI Grok OAuth — the interactive login flow: PKCE + a loopback callback server
 * against accounts.x.ai, plus a manual code-paste fallback for environments the
 * loopback can't reach. On success it hands tokens to saveXaiTokens (./xai.ts),
 * which owns the token lifecycle from there.
 *
 * xAI quirks: /authorize MUST include `plan=generic` (accounts.x.ai rejects
 * loopback OAuth from non-allowlisted clients otherwise), and token exchange
 * must ECHO `code_challenge` + `code_challenge_method` alongside the verifier —
 * xAI re-validates the challenge at the token endpoint, not just at /authorize.
 */

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
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
