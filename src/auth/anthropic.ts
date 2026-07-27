import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { writeSecretFileAtomic } from "./secret-file.js";
import { readProviderCredentials, writeProviderCredentials } from "./storage.js";

import { createLogger } from "../logger.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";
const logger = createLogger("auth-anthropic");

/**
 * Anthropic auth — Claude subscription access.
 *
 * Two supported paths. Both now reach Anthropic over direct HTTPS wearing
 * Claude Code's identity (anthropic-client/oauth-direct.ts) — same credential,
 * same plan billing, NO `claude` subprocess. The CLI transport is hidden behind
 * anthropic-client/cli-transport.ts; nothing here should assume it exists.
 *   1. Subscription sign-in — the in-app paste-the-code OAuth flow. We run the
 *      same PKCE authorize the `claude` CLI uses (client_id, scopes, code=true),
 *      the user authorizes in the browser, copies the code the page shows, and
 *      pastes it back. No binary is involved at any point: the exchange is a
 *      plain fetch and the grant lands in ~/.lax/anthropic-auth.json, which LAX
 *      owns and can refresh.
 *   2. Setup-token (`claude setup-token`) — pasted in, saved here as a
 *      method:"token" bearer in ~/.lax/anthropic-auth.json.
 *
 * Why the grant lives in LAX's own store: it is a SEPARATE authorization from
 * any standalone CLI login, so refreshing it can't rotate a real Claude Code
 * install's refresh token out from under it. ~/.claude/.credentials.json is
 * still READ (source 3 in getAnthropicDirectToken) for users who signed in
 * before this change, and is only WRITTEN when the hidden CLI transport is
 * explicitly re-enabled.
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
  try {
    const data = readProviderCredentials(authPath, "anthropic");
    if (data === null) return null;
    if (typeof data === "object" && typeof (data as Partial<AnthropicTokens>).accessToken === "string") {
      const tokens = data as AnthropicTokens;
      const method = tokens.method || (tokens.refreshToken ? "oauth" : "token");
      return { ...tokens, provider: "anthropic", method };
    }
    logger.error(`[auth-anthropic] ${authPath} parsed OK but missing accessToken — treating as no-auth`);
  } catch (e) {
    // Loud — previous silent catch hid corrupt-file failures from the user.
    logger.error(`[auth-anthropic] FAILED to load ${authPath}: ${(e as Error).message} — treating as no-auth. Re-login if this persists.`);
  }
  return null;
}

function saveAnthropicTokens(tokens: AnthropicTokens): void {
  writeProviderCredentials(getAuthPath(), "anthropic", tokens);
}

// ── Token Refresh ──

export async function refreshAnthropicTokens(tokens: AnthropicTokens): Promise<AnthropicTokens> {
  if (tokens.method === "token") return tokens;
  if (isLocalOnlyMode()) throw new Error(LOCAL_ONLY_BLOCK_MESSAGE);
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

  // Saved setup-token → direct bearer auth.
  const tokens = loadAnthropicTokens();
  if (tokens?.method === "token") return `oauth:${tokens.accessToken}`;

  const { isAnthropicCliTransportEnabled } = await import("../anthropic-client/cli-transport.js");
  if (isAnthropicCliTransportEnabled()) {
    // Hidden legacy path, explicitly re-enabled: the subprocess authenticates
    // from its own credential store, so the sentinel carries no bearer.
    if (tokens) return "cli";
    try {
      const { execSync } = await import("child_process");
      const { npmAugmentedEnv } = await import("../anthropic-client/cli-path.js");
      execSync("claude --version", { timeout: 3000, stdio: "pipe", env: npmAugmentedEnv() });
      return "cli";
    } catch { /* binary absent → fall through to the direct path below */ }
  }

  // Default path. Every remaining subscription source — a legacy refreshable
  // `oauth` grant in LAX's store, or the CLI credential FILE (readable whether
  // or not the binary is installed) — resolves through the one direct-token
  // resolver. This used to return the "cli" sentinel, which routed into a
  // `claude` subprocess and hung forever when the binary was missing.
  const direct = await getAnthropicDirectToken();
  if (direct) return `oauth:${direct}`;

  throw new Error("No Anthropic API key or OAuth tokens. Sign in via Settings → Account.");
}

/**
 * Resolve a RAW bearer token for the direct-HTTP OAuth path (chat "Thinking"
 * block), or null if none is usable. Unlike getAnthropicApiKey — which returns
 * the "cli" sentinel for subscription auth so requests route through the CLI
 * subprocess — this returns the actual token so streamViaAPI can wear Claude
 * Code's identity and stream reasoning text (the CLI redacts it).
 *
 * Sources, in precedence order. NONE of them rotate a lineage the standalone
 * `claude` CLI depends on:
 *   1. ANTHROPIC_OAUTH_TOKEN env — used verbatim.
 *   2. LAX's own store (~/.lax/anthropic-auth.json): a `token` (setup-token) is
 *      long-lived and used as-is; an `oauth` token is refreshed by us when
 *      expired (LAX owns that lineage — its refresh token isn't shared with the
 *      CLI).
 *   3. The Claude CLI credential FILE (~/.claude/.credentials.json), but ONLY
 *      while its access token is unexpired. We deliberately never refresh this
 *      one: on macOS the CLI keeps its live token in the Keychain and this file
 *      is a stale artifact, and refreshing a shared lineage would rotate the
 *      CLI's refresh token out from under it. Expired file → null → the caller
 *      falls back to the CLI proxy (no thinking, but no breakage).
 *
 * Returns null (not throw) when nothing is available — the caller treats that
 * as "use the CLI path".
 */
export async function getAnthropicDirectToken(): Promise<string | null> {
  const envTok = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (envTok) return envTok;

  const tokens = loadAnthropicTokens();
  if (tokens?.method === "token" && tokens.accessToken) return tokens.accessToken;
  if (tokens?.method === "oauth" && tokens.refreshToken) {
    try {
      const fresh = isAnthropicTokenExpired(tokens) ? await refreshAnthropicTokens(tokens) : tokens;
      if (fresh.accessToken) return fresh.accessToken;
    } catch (e) {
      logger.warn(`[auth-anthropic] direct-token refresh failed: ${(e as Error).message} — falling back to CLI path`);
    }
  }

  // Claude CLI credential file — use only if unexpired (never refresh; see above).
  try {
    const credPath = getClaudeCredentialsPath();
    if (existsSync(credPath)) {
      const cred = JSON.parse(readFileSync(credPath, "utf-8")) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
      const o = cred.claudeAiOauth;
      if (o?.accessToken && (!o.expiresAt || Date.now() < o.expiresAt)) return o.accessToken;
    }
  } catch { /* unreadable/corrupt → no direct token */ }

  return null;
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
  if (!pending) throw new Error("No sign-in in progress. Click “Sign in with Claude subscription” first.");
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

  // LAX's OWN store is the primary destination: it is the only one we can
  // REFRESH, and it doesn't touch a standalone Claude Code install's lineage.
  // Save unconditionally — a grant with no refresh_token is still usable as a
  // bearer until it expires, and dropping it here used to leave the user with
  // no credential at all when Anthropic returned a refresh-less grant.
  saveAnthropicTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Mirror refreshAnthropicTokens' 5-min buffer so we refresh just before
    // the API would start rejecting the token.
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - 5 * 60 * 1000 : undefined,
    method: data.refresh_token ? "oauth" : "token",
    provider: "anthropic",
  });

  // The CLI's own credential file is written ONLY when the hidden subprocess
  // transport is re-enabled — that file is the sole thing the subprocess reads.
  // With the CLI hidden this write is pure downside: it CLOBBERS the login of a
  // standalone Claude Code install the user may rely on outside LAX.
  const { isAnthropicCliTransportEnabled } = await import("../anthropic-client/cli-transport.js");
  if (isAnthropicCliTransportEnabled()) {
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
    writeSecretFileAtomic(credPath, JSON.stringify(credPayload, null, 2));
  }

  pendingOAuth = null;
  logger.info("[anthropic-auth] subscription grant saved via paste-the-code OAuth");
}

// ── Delete tokens (disconnect) ──

export function deleteAnthropicTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) unlinkSync(authPath);
}
