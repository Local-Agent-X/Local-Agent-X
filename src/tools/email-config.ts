import { homedir } from "node:os";
import { resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Send-once window for identical (to, cc, subject, body) payloads. The
// in-process dedup phase already catches MCP-loop within-turn dupes at
// 60s; this is the cross-turn / cross-session backstop because the user
// has confirmed duplicate sends via Fastmail in the wild. Five minutes
// is long enough to catch a model that re-tries after a thought delay
// or a separate-turn nudge, short enough that a deliberate human
// "actually send a second identical follow-up" works after the window.
export const EMAIL_SEND_WINDOW_MS = 5 * 60 * 1000;

export function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// Load email config from ~/.lax/email.json (set via Connected APIs UI) or env vars
function loadEmailJson(): Record<string, string> {
  try {
    const p = resolve(getLaxDir(), "email.json");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

export function vault(key: string): string | undefined {
  // Read from the encrypted secrets vault (AES-256-GCM, DPAPI-protected key).
  // Used for the SMTP/IMAP password so it never sits plaintext in email.json.
  // Non-secret config (host/user/from) stays in email.json.
  try {
    const { getSecretsStoreSingleton } = require("../secrets.js") as typeof import("../secrets.js");
    return getSecretsStoreSingleton()?.get(key);
  } catch { return undefined; }
}

/** Resolve which secret name holds the SMTP password.
 *  Lets users reuse an existing secret (e.g. one they saved as `FASTMAIL`)
 *  instead of forcing it to be renamed `SMTP_PASS`. Defaults preserve
 *  backward-compat for setups that already store under SMTP_PASS. */
function resolvePasswordSecretName(kind: "SMTP" | "IMAP"): string {
  const json = loadEmailJson();
  const configured = json[`${kind}_PASS_SECRET`];
  if (configured && configured.trim()) return configured.trim();
  return `${kind}_PASS`;
}

function env(key: string): string | undefined {
  // Password fields resolve vault FIRST so the agent's captured credential
  // wins over any stale env/json value. The lookup name comes from
  // email.json's *_PASS_SECRET pointer (default SMTP_PASS / IMAP_PASS) so
  // the agent can configure email against any existing saved secret.
  if (key === "SMTP_PASS" || key === "IMAP_PASS") {
    const kind = key === "SMTP_PASS" ? "SMTP" : "IMAP";
    const secretName = resolvePasswordSecretName(kind);
    const v = vault(secretName);
    if (v) return v;
    // Backward compat: if the configured name didn't yield a value, also
    // try the literal SMTP_PASS / IMAP_PASS so old setups keep working.
    if (secretName !== key) {
      const legacy = vault(key);
      if (legacy) return legacy;
    }
  }
  return process.env[key] || loadEmailJson()[key] || undefined;
}

/** Write non-secret SMTP config to ~/.lax/email.json. Password is NOT written
 *  here — it must be stored in the secrets vault as SMTP_PASS. */
export function writeEmailJson(patch: Record<string, string>): void {
  const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = resolve(getLaxDir());
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, "email.json");
  let existing: Record<string, string> = {};
  try { if (existsSync(p)) existing = JSON.parse(readFileSync(p, "utf-8")); } catch {}
  const merged = { ...existing, ...patch };
  // Strip any previously-stored plaintext passwords — they now belong in the vault.
  delete merged.SMTP_PASS;
  delete merged.IMAP_PASS;
  writeFileSync(p, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getSmtpConfig(): { host: string; port: number; user: string; pass: string; from: string } | string {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM");
  if (!host || !user || !pass || !from) {
    const missing = [!host && "SMTP_HOST", !user && "SMTP_USER", !pass && "SMTP_PASS", !from && "SMTP_FROM"].filter(Boolean);
    return `Email not configured. Go to Settings → Connected APIs → Email (SMTP/IMAP) to set up, or set env vars: ${missing.join(", ")}`;
  }
  return { host, port: Number(env("SMTP_PORT")) || 587, user, pass, from };
}

export function getImapConfig(): { host: string; port: number; user: string; pass: string } | string {
  const host = env("IMAP_HOST");
  const user = env("IMAP_USER");
  const pass = env("IMAP_PASS");
  if (!host || !user || !pass) {
    const missing = [!host && "IMAP_HOST", !user && "IMAP_USER", !pass && "IMAP_PASS"].filter(Boolean);
    return `Email reading not configured. Go to Settings → Connected APIs → Email (SMTP/IMAP) to set up, or set env vars: ${missing.join(", ")}`;
  }
  return { host, port: Number(env("IMAP_PORT")) || 993, user, pass };
}
