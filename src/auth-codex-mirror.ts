/**
 * Codex CLI credential bridge.
 *
 * The Codex CLI subprocess used by build_app reads tokens from
 * ~/.codex/auth.json. When LAX_MIRROR_CODEX_AUTH is set, this module
 * writes a copy of LAX's OAuth tokens there on every saveTokens (login
 * + refresh) so the CLI can authenticate without a separate flow.
 *
 * The mirror is opt-in (default OFF) because it doubles the on-disk
 * credential surface — stolen laptop / leaked backup leaks two files
 * instead of one. Users who actively need build_app enable the env var.
 *
 * When the mirror is disabled, both the file write AND the
 * @openai/codex auto-install are skipped — no point pulling a CLI we
 * can't authenticate.
 */
import { writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";
import type { OAuthTokens } from "./types.js";

const logger = createLogger("auth");

/** Exported for tests. Reads LAX_MIRROR_CODEX_AUTH; default OFF. */
export function isCodexMirrorEnabled(): boolean {
  const raw = process.env.LAX_MIRROR_CODEX_AUTH;
  if (typeof raw !== "string") return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true";
}

// Once-per-process notice when saveTokens runs with the mirror off.
// Surfaces the env var name so users hitting "build_app can't auth"
// have a single string to grep their own logs for.
let _mirrorDisabledNoticeFired = false;
export function warnMirrorDisabledOnce(): void {
  if (_mirrorDisabledNoticeFired) return;
  _mirrorDisabledNoticeFired = true;
  logger.info("[auth] Codex CLI credential mirror is disabled (LAX_MIRROR_CODEX_AUTH unset). build_app's Codex subprocess will not auto-authenticate from LAX tokens. To enable, set LAX_MIRROR_CODEX_AUTH=1; alternatively run `codex login` directly.");
}

/** Test seam: reset the once-fired flag so cases can observe their own log. */
export function _resetMirrorOnceFlagForTests(): void {
  _mirrorDisabledNoticeFired = false;
}

// One install per process via the in-flight promise gate so we don't race.
let _codexCliInstallInFlight: Promise<void> | null = null;

/**
 * After the bridge writes auth.json, ensure the codex binary is on
 * PATH. If missing, install @openai/codex globally (async, non-blocking).
 * Tokens without a CLI to consume them are useless, but token-save
 * stays fast — install runs in the background.
 */
function ensureCodexCliInstalled(): void {
  if (_codexCliInstallInFlight) return;
  try {
    const check = spawnSync("codex", ["--version"], { stdio: "ignore", shell: process.platform === "win32", timeout: 3000 });
    if (check.status === 0) return;
  } catch { /* fall through to install */ }
  logger.info("[auth] Codex CLI not on PATH — installing @openai/codex globally (background)…");
  _codexCliInstallInFlight = new Promise<void>((resolve) => {
    const proc = spawn("npm", ["install", "-g", "@openai/codex"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    proc.on("exit", (code) => {
      if (code === 0) logger.info("[auth] Codex CLI installed — build_app is now available");
      else logger.warn(`[auth] Codex CLI install exited with ${code}. Install manually if needed: npm install -g @openai/codex`);
      _codexCliInstallInFlight = null;
      resolve();
    });
    proc.on("error", (e) => {
      logger.warn(`[auth] Codex CLI install spawn failed: ${e.message}. Install manually: npm install -g @openai/codex`);
      _codexCliInstallInFlight = null;
      resolve();
    });
  });
}

/**
 * Decode a JWT payload without verifying. We got the token from a
 * trusted endpoint over TLS and we're just reading a claim, not
 * authenticating anyone with it. Returns null on parse failure.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch { return null; }
}

/**
 * Pull the ChatGPT account_id claim out of the id_token. Tries the
 * known OpenAI claim shapes (discovered empirically from a working
 * ~/.codex/auth.json). Returns null if no claim is present.
 */
function extractAccountId(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  for (const k of ["chatgpt_account_id", "account_id", "https://api.openai.com/auth/chatgpt_account_id"]) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const auth = payload["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const a = auth as Record<string, unknown>;
    for (const k of ["chatgpt_account_id", "account_id"]) {
      const v = a[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
}

/**
 * Write a mirror of LAX's OAuth tokens to ~/.codex/auth.json in the
 * shape the Codex CLI expects:
 *
 *   {
 *     "auth_mode": "chatgpt",
 *     "OPENAI_API_KEY": null,
 *     "tokens": { id_token, access_token, refresh_token, account_id },
 *     "last_refresh": "ISO 8601"
 *   }
 *
 * Atomic write (tmp + rename). Logs and continues on any failure —
 * the LAX-side auth.json is the source of truth; this mirror is a
 * convenience for the CLI subprocess and shouldn't crash chat if the
 * write fails (e.g. permissions on ~/.codex/).
 *
 * Exported for tests so the gate in saveTokens can be observed via spy.
 */
export function mirrorToCodexCli(tokens: OAuthTokens): void {
  if (!tokens.idToken) {
    logger.warn("[auth] saveTokens called without id_token — Codex CLI bridge skipped. The CLI will pick up tokens on the next refresh.");
    return;
  }
  const codexPath = join(homedir(), ".codex", "auth.json");
  const accountId = tokens.accountId ?? extractAccountId(tokens.idToken) ?? "";
  const codexAuth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  const tmp = `${codexPath}.tmp`;
  try {
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(codexAuth, null, 2), { mode: 0o600 });
    renameSync(tmp, codexPath);
    logger.info(`[auth] mirrored tokens to ${codexPath} (Codex CLI bridge)`);
    ensureCodexCliInstalled();
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    logger.warn(`[auth] Codex CLI bridge write failed: ${(e as Error).message}`);
  }
}

/**
 * Indirection so tests can swap the implementation via vi.spyOn. The
 * gate in saveTokens calls `mirrorImpl.fn`, not the raw identifier,
 * which is what makes the gate observable from outside.
 */
export const mirrorImpl: { fn: (tokens: OAuthTokens) => void } = {
  fn: mirrorToCodexCli,
};
