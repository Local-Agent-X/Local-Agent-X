import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth-anthropic");

/**
 * Anthropic auth — Claude subscription access.
 *
 * Two supported paths, both routed through the official Claude CLI subprocess
 * (the only third-party usage Anthropic's TOS permits):
 *   1. Claude CLI login (`claude auth login`) — credentials live in
 *      ~/.claude/.credentials.json, managed by the CLI, not stored here.
 *   2. Setup-token (`claude setup-token`) — pasted in, saved here as a
 *      method:"token" bearer in ~/.lax/anthropic-auth.json.
 *
 * The old in-app direct-OAuth flow (localhost PKCE callback → ~/.lax tokens)
 * was removed: Anthropic blocks Pro/Max OAuth tokens in third-party tools, so
 * those tokens returned "Not logged in" on inference. Legacy method:"oauth"
 * tokens already on disk are still loaded/refreshed for backward-compat.
 */

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface AnthropicTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  method?: "oauth" | "token";
  provider: "anthropic";
}

function getAuthPath(): string {
  return join(getLaxDir(), "anthropic-auth.json");
}

// ── Token Storage ──

export function loadAnthropicTokens(): AnthropicTokens | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    if (data.accessToken) {
      const method = data.method || (data.refreshToken ? "oauth" : "token");
      return { ...data, provider: "anthropic", method } as AnthropicTokens;
    }
    logger.error(`[auth-anthropic] ${authPath} parsed OK but missing accessToken — treating as no-auth`);
  } catch (e) {
    // Loud — previous silent catch hid corrupt-file failures from the user.
    logger.error(`[auth-anthropic] FAILED to parse ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
  }
  return null;
}

function saveAnthropicTokens(tokens: AnthropicTokens): void {
  // Atomic write — same race protection as auth.ts saveTokens. Mid-write
  // crash used to leave anthropic-auth.json half-written; next load
  // logged corruption (since this commit) but the user lost their auth.
  const authPath = getAuthPath();
  const tmp = `${authPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// ── Token Refresh ──

export async function refreshAnthropicTokens(tokens: AnthropicTokens): Promise<AnthropicTokens> {
  if (tokens.method === "token") return tokens;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newTokens: AnthropicTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000, // 5 min buffer
    method: "oauth",
    provider: "anthropic",
  };

  saveAnthropicTokens(newTokens);
  return newTokens;
}

// ── Get Valid Anthropic API Key ──

export async function getAnthropicApiKey(): Promise<string> {
  // Check for direct API key in env (console API keys use direct HTTP)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_OAUTH_TOKEN) return `oauth:${process.env.ANTHROPIC_OAUTH_TOKEN.trim()}`;

  // Saved subscription token → direct bearer auth.
  // Saved legacy OAuth tokens → use the refresh-capable "cli" sentinel path.
  const tokens = loadAnthropicTokens();
  if (tokens?.method === "token") return `oauth:${tokens.accessToken}`;
  if (tokens) return "cli";

  // Check if Claude CLI is available (it has its own credentials)
  try {
    const { execSync } = await import("child_process");
    const { npmAugmentedEnv } = await import("../anthropic-client/cli-path.js");
    execSync("claude --version", { timeout: 3000, stdio: "pipe", env: npmAugmentedEnv() });
    return "cli";
  } catch {}

  throw new Error("No Anthropic API key or OAuth tokens. Sign in via Settings → General.");
}

export function isAnthropicTokenExpired(tokens: AnthropicTokens | null): boolean {
  if (!tokens) return false;
  if (tokens.method === "token") return false;
  return !!tokens.expiresAt && Date.now() > tokens.expiresAt;
}

export function saveAnthropicSetupToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length < 20) {
    throw new Error("Anthropic setup-token looks invalid.");
  }
  saveAnthropicTokens({
    accessToken: trimmed,
    method: "token",
    provider: "anthropic",
  });
}

// ── Delete tokens (disconnect) ──

export function deleteAnthropicTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) unlinkSync(authPath);
}
