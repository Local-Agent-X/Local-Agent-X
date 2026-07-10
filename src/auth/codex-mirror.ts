/**
 * Codex CLI credential bridge.
 *
 * The Codex CLI subprocess used by build_app reads tokens from
 * ~/.codex/auth.json. This module writes LAX's OAuth tokens there in the
 * shape the CLI expects so it can authenticate without a separate flow.
 *
 * The mirror is a plaintext copy of live OAuth tokens (0600, but the CLI's
 * format can't carry our AES-GCM envelope). To keep that plaintext copy off
 * disk except when it's actually needed, the default is NOT to mirror on
 * every login/refresh. Instead build_app calls prepareCodexAuthForBuild(),
 * which uses an existing CLI store unchanged or creates and removes a
 * just-in-time file when none exists. A Codex-connected user who never builds
 * never has a second on-disk credential, and the file isn't rewritten on every
 * token refresh.
 *
 * Env-var gates:
 *   - LAX_MIRROR_CODEX_AUTH=1   → ALSO eager-mirror on every saveTokens and
 *                                 keep the file persistent (for running the
 *                                 Codex CLI directly, outside build_app)
 *   - LAX_MIRROR_CODEX_AUTH=0   → never mirror, not even for a build (run
 *                                 `codex login` yourself)
 *   - LAX_INSTALL_CODEX_CLI=1   → if codex is not on PATH, run
 *                                 `npm install -g @openai/codex` in the
 *                                 background
 *
 * The install gate is separate so token-save doesn't silently trigger a
 * network call + global package install on a fresh laptop just because
 * the user opted into the file mirror.
 */
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";
import { writeSecretFileAtomic } from "./secret-file.js";
import type { OAuthTokens } from "../types.js";

const logger = createLogger("auth");

/** True only when LAX_MIRROR_CODEX_AUTH=1/true — the opt-in persistent mirror
 *  that writes ~/.codex/auth.json on every saveTokens. Default OFF; build_app
 *  handles the common case lazily via prepareCodexAuthForBuild. */
export function isCodexEagerMirrorEnabled(): boolean {
  const v = (process.env.LAX_MIRROR_CODEX_AUTH ?? "").toLowerCase();
  return v === "1" || v === "true";
}

/** True when LAX_MIRROR_CODEX_AUTH=0/false/off/no — a hard opt-out that
 *  suppresses even the just-in-time build write (the user runs `codex login`
 *  themselves). */
export function isCodexMirrorDisabled(): boolean {
  const v = (process.env.LAX_MIRROR_CODEX_AUTH ?? "").toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/**
 * Reads LAX_INSTALL_CODEX_CLI; default OFF. Gates the auto `npm install
 * -g @openai/codex` that runs when codex is missing from PATH. Separate
 * from the mirror gate because "save my tokens" and "install a global
 * CLI on my machine" are different consent decisions.
 */
export function isCodexAutoInstallEnabled(): boolean {
  const raw = process.env.LAX_INSTALL_CODEX_CLI;
  if (typeof raw !== "string") return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true";
}

// One install per process via the in-flight promise gate so we don't race.
let _codexCliInstallInFlight: Promise<void> | null = null;

/**
 * After the bridge writes auth.json, ensure the codex binary is on
 * PATH. If missing AND LAX_INSTALL_CODEX_CLI=1, install @openai/codex
 * globally (async, non-blocking). If missing and the install gate is
 * OFF, log an actionable manual-install hint and return — token-save
 * shouldn't silently run `npm install -g` over the network on a fresh
 * laptop just because the user enabled the credential mirror.
 */
function ensureCodexCliInstalled(): void {
  if (_codexCliInstallInFlight) return;
  try {
    const check = spawnSync("codex", ["--version"], { stdio: "ignore", shell: process.platform === "win32", timeout: 3000 });
    if (check.status === 0) return;
  } catch { /* fall through */ }
  if (!isCodexAutoInstallEnabled()) {
    logger.info(
      "[auth] Codex CLI not on PATH and auto-install is OFF (LAX_INSTALL_CODEX_CLI unset). " +
      "Install manually with: npm install -g @openai/codex — or set LAX_INSTALL_CODEX_CLI=1 " +
      "to let LAX install it in the background on the next token save.",
    );
    return;
  }
  logger.info("[auth] Codex CLI not on PATH — installing @openai/codex globally (background, LAX_INSTALL_CODEX_CLI=1)…");
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
  try {
    mkdirSync(dirname(codexPath), { recursive: true });
    writeSecretFileAtomic(codexPath, JSON.stringify(codexAuth, null, 2));
    logger.info(`[auth] mirrored tokens to ${codexPath} (Codex CLI bridge)`);
    ensureCodexCliInstalled();
  } catch (e) {
    logger.warn(`[auth] Codex CLI bridge write failed: ${(e as Error).message}`);
  }
}

/**
 * Just-in-time Codex auth for a build_app run. Called immediately before
 * build_app spawns the Codex CLI; returns a cleanup function to call after
 * the subprocess exits.
 *
 *   - LAX_MIRROR_CODEX_AUTH=0  → no-op (user manages ~/.codex/auth.json).
 *   - LAX_MIRROR_CODEX_AUTH=1  → persistent mirror already maintained by
 *                                saveTokens; write nothing, delete nothing.
 *   - default                  → use a pre-existing CLI store unchanged, or
 *                                write a temporary mirror from the current
 *                                LAX tokens and remove it after the build.
 *
 * Keeping the plaintext mirror on disk only for the duration of a build is
 * the at-rest-minimization the always-on mirror couldn't give us.
 */
export async function prepareCodexAuthForBuild(): Promise<() => void> {
  const noop = (): void => { /* nothing to undo */ };
  if (isCodexMirrorDisabled() || isCodexEagerMirrorEnabled()) return noop;

  const codexPath = join(homedir(), ".codex", "auth.json");
  if (existsSync(codexPath)) {
    logger.info(`[auth] using existing Codex CLI credentials at ${codexPath}; temporary LAX mirror skipped`);
    return noop;
  }

  const { loadTokens } = await import("./index.js");
  const tokens = loadTokens();
  if (!tokens?.idToken) return noop; // nothing to mirror; Codex falls back to its own login

  mirrorImpl.fn(tokens);
  return (): void => {
    try { if (existsSync(codexPath)) unlinkSync(codexPath); } catch { /* best-effort */ }
  };
}

/**
 * Indirection so tests can swap the implementation via vi.spyOn. The
 * gate in saveTokens calls `mirrorImpl.fn`, not the raw identifier,
 * which is what makes the gate observable from outside.
 */
export const mirrorImpl: { fn: (tokens: OAuthTokens) => void } = {
  fn: mirrorToCodexCli,
};
