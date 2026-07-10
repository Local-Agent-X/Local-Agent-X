import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { readProviderCredentials, writeProviderCredentials } from "./storage.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth-xai");

/**
 * xAI Grok OAuth — SuperGrok / X Premium+ subscription access via PKCE flow
 * against accounts.x.ai. Bearer token is consumed as a standard API key on
 * https://api.x.ai/v1 (OpenAI-compat), so the OpenAI HTTP adapter consumes
 * it with zero transport changes.
 *
 * This module owns the token LIFECYCLE — store, load, expiry, refresh, and the
 * runtime credential (getXaiApiKey). The interactive browser login flow lives
 * in ./xai-login.ts and calls back into saveXaiTokens + fetchOidcDiscovery here.
 *
 * xAI quirk worth knowing: standard SuperGrok subscribers can OAuth-login
 * successfully but get HTTP 403 on inference. Documented in the Settings UI as
 * the fallback path to a plain XAI_API_KEY.
 */

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const SCOPE = "openid profile email offline_access grok-cli:access api:access";
// Refresh well before the ~6h xAI access token actually expires. A tight window
// is fine for interactive chat but leaves gaps for long-idle callers (cron,
// bridges, background classifiers) that may not touch xAI for 30+ min and would
// otherwise hit an expired token or eat a blocking refresh mid-call. We store the
// REAL expiry and treat "within this window of it" as due-for-refresh, so the
// skew is applied exactly ONCE — not baked into expiresAt as well.
const REFRESH_SKEW_MS = 60 * 60 * 1000;

export interface XaiTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  provider: "xai";
}

export interface OidcEndpoints { authorizationEndpoint: string; tokenEndpoint: string; }

function getAuthPath(): string {
  return join(getLaxDir(), "xai-auth.json");
}

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

export async function fetchOidcDiscovery(): Promise<OidcEndpoints> {
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
  try {
    const data = readProviderCredentials(authPath, "xai");
    if (data === null) return null;
    if (typeof data === "object" && typeof (data as Partial<XaiTokens>).accessToken === "string") {
      return { ...(data as XaiTokens), provider: "xai" };
    }
    logger.error(`[auth-xai] ${authPath} parsed but missing accessToken — treating as no-auth`);
  } catch (e) {
    logger.error(`[auth-xai] FAILED to load ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
  }
  return null;
}

export function saveXaiTokens(tokens: XaiTokens): void {
  writeProviderCredentials(getAuthPath(), "xai", tokens);
}

export function isXaiTokenExpired(tokens: XaiTokens | null): boolean {
  if (!tokens) return false;
  return !!tokens.expiresAt && Date.now() > tokens.expiresAt;
}

// True when the token is at, past, or within REFRESH_SKEW_MS of its real expiry
// — i.e. due for a proactive refresh. Pure + exported so the refresh-timing
// policy is unit-testable without a live token exchange. A token with unknown
// expiry is never force-refreshed (we can't know it's stale).
export function shouldRefreshXaiToken(tokens: XaiTokens | null): boolean {
  if (!tokens || !tokens.expiresAt) return false;
  return Date.now() > tokens.expiresAt - REFRESH_SKEW_MS;
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
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
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
  if (shouldRefreshXaiToken(tokens)) {
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
