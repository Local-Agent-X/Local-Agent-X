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

import { loadTokens, refreshTokens } from "./auth.js";
import { loadAnthropicTokens, refreshAnthropicTokens } from "./auth-anthropic.js";

const CHECK_INTERVAL_MS = 2 * 60 * 1000;     // Every 2 minutes
const REFRESH_WINDOW_MS = 10 * 60 * 1000;    // Refresh if expiring within 10 min

let timer: ReturnType<typeof setInterval> | null = null;

async function tickCodex(): Promise<void> {
  try {
    const tokens = loadTokens();
    if (!tokens) return;
    if (Date.now() < tokens.expiresAt - REFRESH_WINDOW_MS) return;
    await refreshTokens(tokens);
    console.log("[auth-refresh] Codex tokens refreshed proactively");
  } catch (e) {
    console.warn(`[auth-refresh] Codex refresh failed (will retry next tick): ${(e as Error).message}`);
  }
}

async function tickAnthropic(): Promise<void> {
  try {
    const tokens = loadAnthropicTokens();
    if (!tokens) return;
    // Subscription tokens (method: "token") don't expire
    if (tokens.method === "token") return;
    if (!tokens.expiresAt) return;
    if (Date.now() < tokens.expiresAt - REFRESH_WINDOW_MS) return;
    await refreshAnthropicTokens(tokens);
    console.log("[auth-refresh] Anthropic tokens refreshed proactively");
  } catch (e) {
    console.warn(`[auth-refresh] Anthropic refresh failed (will retry next tick): ${(e as Error).message}`);
  }
}

export function startAuthRefreshTimer(): void {
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
  console.log(`[auth-refresh] Background token refresh armed (every ${CHECK_INTERVAL_MS / 1000}s)`);
}

export function stopAuthRefreshTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
