import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

import { createLogger } from "../logger.js";
const logger = createLogger("auth-anthropic");

/**
 * Anthropic auth — Claude subscription access.
 *
 * Two supported paths, both routed through the official Claude CLI subprocess
 * (the only third-party usage Anthropic's TOS permits):
 *   1. Claude CLI login — the in-app paste-the-code OAuth flow. We run the same
 *      PKCE authorize the `claude` CLI uses (client_id, scopes, code=true), the
 *      user authorizes in the browser, copies the code the page shows, and pastes
 *      it back. We exchange it and write the result into the CLI's own credential
 *      store (~/.claude/.credentials.json) so the chat/build subprocess — which
 *      authenticates ONLY from that file, never from a token we'd hold — uses it.
 *   2. Setup-token (`claude setup-token`) — pasted in, saved here as a
 *      method:"token" bearer in ~/.lax/anthropic-auth.json.
 *
 * Why write the CLI's file instead of holding the token ourselves: Anthropic
 * blocks Pro/Max OAuth tokens used DIRECTLY by third-party apps (returns "Not
 * logged in" on inference). Routing through the official CLI subprocess is the
 * permitted path, and that subprocess reads only ~/.claude/.credentials.json.
 * The removed localhost-callback variant stored tokens in ~/.lax and used them
 * directly — which is exactly what Anthropic blocks. Legacy method:"oauth"
 * tokens already on disk are still loaded/refreshed for backward-compat.
 */

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Manual-paste redirect: the OAuth server shows the code on this page instead of
// redirecting to a localhost port, so the user can copy it back into the app.
// Matches what the `claude` CLI itself requests (verified from its printed URL).
const CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

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

/**
 * True when the Claude CLI itself is logged in — ~/.claude/.credentials.json
 * holds an OAuth token (what the paste-the-code flow and `claude auth login`
 * both write) or config.json shows an account/key. The chat/build subprocess
 * authenticates from these files, so this — NOT loadAnthropicTokens() (our
 * ~/.lax setup-token store) — is the real "Anthropic is usable" signal. Both
 * the auth status route and the provider list must agree on it, or Settings
 * says "Connected" while the chat picker omits Anthropic (the exact bug this
 * fixes).
 */
export function isAnthropicCliAuthenticated(): boolean {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(credPath)) {
      try {
        const cred = JSON.parse(readFileSync(credPath, "utf-8"));
        if (cred?.claudeAiOauth?.accessToken || cred?.primaryApiKey) return true;
      } catch { /* corrupt file → not authed */ }
    }
    const configPath = join(homedir(), ".claude", "config.json");
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        if (cfg.oauthAccount || cfg.primaryApiKey || cfg.customApiKeyResponses) return true;
      } catch { /* corrupt file → not authed */ }
    }
  } catch { /* fs error → not authed */ }
  return false;
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

// ── Paste-the-code OAuth (writes the CLI's own credential store) ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// One pending authorization at a time — the verifier/state must survive between
// "start" (build the URL) and "complete" (exchange the pasted code). In-memory
// only: a restart cancels an in-flight login, which is fine (user re-clicks).
let pendingOAuth: { verifier: string; state: string; createdAt: number } | null = null;

/**
 * Begin the paste-the-code login. Returns the authorize URL to open. The user
 * authorizes, the page shows a code, and they paste it into completeAnthropicCliOAuth.
 * Does NOT open a browser or spawn anything (the old auto-spawn opened the browser
 * twice and could never finish — a backgrounded CLI can't receive the code).
 */
export function startAnthropicCliOAuth(): { authUrl: string } {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  pendingOAuth = { verifier, state, createdAt: Date.now() };

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", CODE_REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  return { authUrl: authUrl.toString() };
}

export function cancelAnthropicCliOAuth(): void {
  pendingOAuth = null;
}

function getClaudeCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/**
 * Exchange the pasted code and write tokens into ~/.claude/.credentials.json in
 * the CLI's format. The pasted value is typically "<code>#<state>" (the callback
 * page concatenates them); accept either form.
 */
export async function completeAnthropicCliOAuth(rawCode: string): Promise<void> {
  const pending = pendingOAuth;
  if (!pending) throw new Error("No sign-in in progress. Click “Sign in via Claude CLI” first.");
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingOAuth = null;
    throw new Error("Sign-in expired (10 min). Start again.");
  }

  const trimmed = (rawCode || "").trim();
  if (!trimmed) throw new Error("Paste the code from the authorization page.");
  // The callback page shows "<code>#<state>"; split it. If no "#", treat the
  // whole thing as the code and fall back to our stored state.
  const hashIdx = trimmed.indexOf("#");
  const code = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const returnedState = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : pending.state;
  if (returnedState !== pending.state) {
    throw new Error("State mismatch — the pasted code doesn't match this sign-in. Start again.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: pending.state,
      redirect_uri: CODE_REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!data.access_token) throw new Error("Token exchange returned no access_token.");

  // Write the CLI's credential file. The key shape (claudeAiOauth.accessToken)
  // is the same one the app's status check already reads, and the chat/build
  // subprocess authenticates from this file.
  const credPath = getClaudeCredentialsPath();
  const credPayload = {
    claudeAiOauth: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
      scopes: (data.scope || SCOPES).split(/\s+/).filter(Boolean),
      subscriptionType: "max",
    },
  };
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  const tmp = `${credPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(credPayload, null, 2), { mode: 0o600 });
    renameSync(tmp, credPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  pendingOAuth = null;
  logger.info("[anthropic-auth] CLI credentials written via paste-the-code OAuth");
}

// ── Delete tokens (disconnect) ──

export function deleteAnthropicTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) unlinkSync(authPath);
}
