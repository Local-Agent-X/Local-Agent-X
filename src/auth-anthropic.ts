import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";

import { createLogger } from "./logger.js";
const logger = createLogger("auth-anthropic");

/**
 * Anthropic OAuth — Claude subscription access via PKCE flow.
 *
 * Same pattern as OpenAI Codex OAuth:
 * 1. Open browser to claude.ai/oauth/authorize
 * 2. User logs in with their Claude account
 * 3. Callback to localhost with auth code
 * 4. Exchange code for access + refresh tokens
 * 5. Use access token as Bearer for api.anthropic.com
 *
 * Tokens stored in ~/.sax/anthropic-auth.json
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code";

export interface AnthropicTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  method?: "oauth" | "token";
  provider: "anthropic";
}

function getAuthPath(): string {
  return join(homedir(), ".lax", "anthropic-auth.json");
}

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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
  } catch {}
  return null;
}

function saveAnthropicTokens(tokens: AnthropicTokens): void {
  writeFileSync(getAuthPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
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
    const { npmAugmentedEnv } = await import("./anthropic-client/cli-path.js");
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

// ── OAuth Login Flow ──

export function initiateAnthropicLogin(): { authUrl: string; promise: Promise<void> } {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const promise = new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404); res.end("Not found"); return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authentication failed</h2><p>${escapeHtml(String(error))}</p><p>You can close this window.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const stateValid = returnedState && returnedState.length === state.length &&
        timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
      if (!code || !stateValid) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Invalid callback</h2><p>Missing code or state mismatch.</p></body></html>`);
        server.close();
        reject(new Error("Invalid OAuth callback"));
        return;
      }

      // Exchange code for tokens
      try {
        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            state,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
        }

        const data = (await tokenRes.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };

        const tokens: AnthropicTokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
          method: "oauth",
          provider: "anthropic",
        };

        saveAnthropicTokens(tokens);
        logger.info("[anthropic-auth] OAuth tokens saved");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;background:#0a0a0f;color:#00ff41;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Connected to Claude!</h2><p>You can close this window and return to Agent X.</p></div></body></html>`);
        server.close();
        resolve();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Token exchange failed</h2><p>${escapeHtml((e as Error).message)}</p></body></html>`);
        server.close();
        reject(e);
      }
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      logger.info(`[anthropic-auth] Waiting for callback on port ${CALLBACK_PORT}...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => { server.close(); reject(new Error("OAuth timeout")); }, 5 * 60 * 1000);
  });

  return { authUrl: authUrl.toString(), promise };
}

// ── Delete tokens (disconnect) ──

export function deleteAnthropicTokens(): void {
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    const { unlinkSync } = require("node:fs");
    unlinkSync(authPath);
  }
}
