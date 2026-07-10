// Background auth-refresh timer.
//
// The lazy `getApiKey()` / `getAnthropicApiKey()` callers only refresh when
// a request arrives and the token is already within 5 minutes of expiry —
// meaning the *first* request after a long idle pays the refresh latency,
// and a transient refresh failure surfaces as a user-visible error.
//
// This timer proactively refreshes both sets of tokens before they hit the
// danger zone. Silent — failures are logged and retried on the next tick
// (or caught by the lazy path).

import { loadTokens, refreshTokens } from "./index.js";
import { loadAnthropicTokens, refreshAnthropicTokens } from "./anthropic.js";
import { isLocalOnlyMode, registerLocalOnlyTeardown } from "../local-only-policy.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth-refresh");

const CHECK_INTERVAL_MS = 2 * 60 * 1000;     // Every 2 minutes
const REFRESH_WINDOW_MS = 10 * 60 * 1000;    // Refresh if expiring within 10 min

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * A refresh failure that RETRYING WILL NEVER FIX — the refresh token itself is
 * expired, revoked, or otherwise rejected by the OAuth server (RFC 6749 §5.2).
 * The only cure is a fresh user login. Distinguishing these from transient
 * failures (network, 5xx, timeout) is the whole point: without it the 2-minute
 * timer hammers a permanently-dead credential forever, flooding the log
 * (live: a 12-day-expired legacy Anthropic token logged an error every 2 min).
 * Both refresh fns throw with the raw OAuth error body in the message, so the
 * standard error codes are matchable there.
 */
export function isUnrecoverableRefreshError(message: string): boolean {
  return /\b(invalid_grant|invalid_client|unauthorized_client)\b/.test(message);
}

// Refresh tokens we've given up on: retrying them is pointless until the user
// re-logs-in, which writes a NEW refresh token that won't be in this set — so a
// fresh login automatically re-arms proactive refresh with no manual reset.
const abandonedRefreshTokens = new Set<string>();

/** Test-only: clear the give-up memory so a suite can re-exercise the path. */
export function _resetAbandonedRefreshTokens(): void { abandonedRefreshTokens.clear(); }

export async function tickCodex(): Promise<void> {
  if (isLocalOnlyMode()) return;
  const tokens = loadTokens();
  if (!tokens) return;
  if (Date.now() < tokens.expiresAt - REFRESH_WINDOW_MS) return;
  if (abandonedRefreshTokens.has(tokens.refreshToken)) return; // already gave up on this exact token
  try {
    await refreshTokens(tokens);
    logger.info("[auth-refresh] Codex tokens refreshed proactively");
  } catch (e) {
    const msg = (e as Error).message;
    if (isUnrecoverableRefreshError(msg)) {
      abandonedRefreshTokens.add(tokens.refreshToken);
      logger.error(`[auth-refresh] Codex refresh token is dead (${msg}) — giving up until you re-login (Settings → General). Will not retry.`);
    } else {
      logger.warn(`[auth-refresh] Codex refresh failed (will retry next tick): ${msg}`);
    }
  }
}

export async function tickAnthropic(): Promise<void> {
  if (isLocalOnlyMode()) return;
  const tokens = loadAnthropicTokens();
  if (!tokens) return;
  // Subscription tokens (method: "token") don't expire
  if (tokens.method === "token") return;
  if (!tokens.expiresAt || !tokens.refreshToken) return;
  if (Date.now() < tokens.expiresAt - REFRESH_WINDOW_MS) return;
  if (abandonedRefreshTokens.has(tokens.refreshToken)) return; // already gave up on this exact token
  try {
    await refreshAnthropicTokens(tokens);
    logger.info("[auth-refresh] Anthropic tokens refreshed proactively");
  } catch (e) {
    const msg = (e as Error).message;
    if (isUnrecoverableRefreshError(msg)) {
      abandonedRefreshTokens.add(tokens.refreshToken);
      logger.error(`[auth-refresh] Anthropic refresh token is dead (${msg}) — giving up until you re-login (Settings → General). Will not retry.`);
    } else {
      logger.warn(`[auth-refresh] Anthropic refresh failed (will retry next tick): ${msg}`);
    }
  }
}

export function startAuthRefreshTimer(): void {
  if (isLocalOnlyMode()) return;
  if (timer) return;
  // Run immediately on startup so we don't wait 2 minutes for the first check
  tickCodex();
  tickAnthropic();
  timer = setInterval(() => {
    tickCodex();
    tickAnthropic();
  }, CHECK_INTERVAL_MS);
  // Don't keep the process alive just for this timer
  if (typeof timer.unref === "function") timer.unref();
  logger.info(`[auth-refresh] Background token refresh armed (every ${CHECK_INTERVAL_MS / 1000}s)`);
}

export function stopAuthRefreshTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

registerLocalOnlyTeardown("oauth-refresh", stopAuthRefreshTimer);
