/**
 * The paste-the-code Claude sign-in: build the authorize URL, then exchange
 * the code the user pastes back for tokens written in the Claude CLI's own
 * credential-store format.
 *
 * Split from auth/anthropic.ts, which had grown two jobs: resolving the
 * token a request should carry (still there) and running an interactive
 * login (here). The route in routes/bridges/auth/anthropic.ts is the only
 * caller.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { writeSecretFileAtomic } from "./secret-file.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";
import {
  AUTH_URL, CLIENT_ID, CODE_REDIRECT_URI, SCOPES, TOKEN_URL,
  getClaudeCredentialsPath, saveAnthropicTokens, type AnthropicTokens,
} from "./anthropic.js";

const logger = createLogger("auth-anthropic");

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
