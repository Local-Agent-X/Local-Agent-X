import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAuthPath } from "./config.js";
import type { OAuthTokens } from "./types.js";

// OpenAI Codex OAuth endpoints (shared public client ID for CLI tools)
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Token Storage ──

export function loadTokens(): OAuthTokens | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    if (data.accessToken && data.refreshToken && data.expiresAt) {
      return data as OAuthTokens;
    }
  } catch {
    // Corrupted file
  }
  return null;
}

function saveTokens(tokens: OAuthTokens): void {
  const authPath = getAuthPath();
  writeFileSync(authPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ── Token Refresh ──

export async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newTokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  saveTokens(newTokens);
  return newTokens;
}

// ── Get Valid API Key ──

export async function getApiKey(configApiKey?: string): Promise<string> {
  // Direct API key takes priority
  if (configApiKey) return configApiKey;

  // Try OAuth tokens
  let tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "No API key or OAuth tokens found. Set OPENAI_API_KEY or run the OAuth login flow."
    );
  }

  // Refresh if expiring within 5 minutes
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  if (Date.now() > tokens.expiresAt - REFRESH_MARGIN_MS) {
    console.log("[auth] Refreshing OAuth tokens...");
    tokens = await refreshTokens(tokens);
  }

  return tokens.accessToken;
}

// ── OAuth Login Flow ──

export async function startOAuthLogin(): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();

  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "openid profile email offline_access");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");

  console.log(`\n[auth] Open this URL in your browser:\n\n  ${authUrl.toString()}\n`);

  // Open browser automatically
  const { exec } = await import("node:child_process");
  const openCmd =
    process.platform === "win32"
      ? "start"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  exec(`${openCmd} "${authUrl.toString()}"`);

  // Wait for callback
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      try {
        // Exchange code for tokens
        const tokenRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            redirect_uri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
            code_verifier: verifier,
          }),
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

        const tokens: OAuthTokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };

        saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="background:#0a0a0f;color:#00ff41;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <h1>Secret Agent X</h1>
              <p>Authentication successful. You can close this tab.</p>
            </div>
          </body></html>
        `);

        clearTimeout(timeout);
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end("Token exchange failed");
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(`[auth] Waiting for OAuth callback on port ${CALLBACK_PORT}...`);
    });
  });
}
