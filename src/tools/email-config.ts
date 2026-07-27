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

/** The non-secret configuration email.json actually holds — the keys env()
 *  above reads back. NOT the `*_PASS_SECRET` pointers: those name a VAULT
 *  ENTRY, and letting a caller set one would repoint the password lookup at any
 *  stored secret (email_send would then authenticate to a caller-chosen host
 *  with, say, ANTHROPIC_API_KEY as the password). They are derived below from
 *  what was actually vaulted, never accepted as input. */
const EMAIL_CONFIG_KEYS = new Set([
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_FROM",
  "IMAP_HOST", "IMAP_PORT", "IMAP_USER",
]);

/** Vault-name pointer each password credential is read through. */
const PASSWORD_POINTERS: Record<string, string> = {
  SMTP_PASS: "SMTP_PASS_SECRET",
  IMAP_PASS: "IMAP_PASS_SECRET",
};

/** The integration identity that OWNS ~/.lax/email.json. */
const EMAIL_CONFIG_OWNER_ID = "email";

/**
 * Whether an integration is the one this config store belongs to.
 *
 * The ONLY admission test for writeEmailCredentials(), and the reason it is
 * IDENTITY and not the integration's own `transport` field: a declaration is
 * caller-authored (POST /api/integrations validates id/name/baseUrl and casts
 * the rest of the body in), so `transport: "smtp_imap"` is a self-assertion, not
 * a credential. Routing the write on it let ANY installed integration merge
 * SMTP_HOST into the real mailbox's config — and because writeEmailJson()
 * merges, the victim's SMTP_USER and SMTP_PASS_SECRET survived, so the next
 * email_send authenticated to the attacker's host with the user's real app
 * password. That is the same argument this file already makes about the
 * `*_PASS_SECRET` pointers, reaching a materially equivalent outcome.
 *
 * `builtin` is not self-asserted: addIntegration() forces it to false on every
 * network-authored config, so an integration that claims the email id still
 * fails this test. Both halves are load-bearing — id alone would admit such a
 * claim, `builtin` alone would admit every other builtin.
 *
 * Structurally typed rather than taking IntegrationConfig, so the store that
 * owns the rule does not have to import the integrations subsystem to state it.
 */
export function ownsEmailConfig(integration: { id?: unknown; builtin?: unknown }): boolean {
  return integration.builtin === true && integration.id === EMAIL_CONFIG_OWNER_ID;
}

/** Configure email from an install's DECLARED credential values.
 *
 *  The single seam Settings → Connected APIs → Email writes through, so email
 *  keeps exactly one config store (writeEmailJson stays the only writer of
 *  ~/.lax/email.json) no matter which of the two paths — this or email_setup —
 *  the user took.
 *
 *  `vaultedSecretNames` are the credential names the install just wrote to the
 *  vault. Each password among them repoints its `*_PASS_SECRET` indirection at
 *  itself. That does NOT break the indirection — it is the indirection being
 *  used correctly: a user who once ran email_setup against a reused entry
 *  (SMTP_PASS_SECRET = "FASTMAIL") and then saves a new password in Settings
 *  would otherwise have the stale pointer shadow it, and every send would keep
 *  using the old credential while Settings reported CONNECTED. A password saved
 *  under a custom name via email_setup is untouched, because this only fires
 *  for a name the install actually stored.
 *
 *  Callers must gate on ownsEmailConfig() first — this writer is reachable only
 *  for the integration that owns this file. See that function for why.
 *
 *  Returns an error instead of writing when a value names something email.json
 *  does not hold; nothing is written in that case. */
export function writeEmailCredentials(
  values: Record<string, string>,
  vaultedSecretNames: string[],
): { error: string } | null {
  const unknown = Object.keys(values).filter(k => !EMAIL_CONFIG_KEYS.has(k));
  if (unknown.length > 0) return { error: `Email configuration has no field named ${unknown.join(", ")}` };
  const patch: Record<string, string> = { ...values };
  for (const name of vaultedSecretNames) {
    const pointer = PASSWORD_POINTERS[name];
    if (pointer) patch[pointer] = name;
  }
  writeEmailJson(patch);
  return null;
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

/**
 * Is IMAP configured? THE single statement of that rule.
 *
 * Every IMAP tool needs it for its `available` predicate, and each of them had
 * written the same one-liner because the chunks that built them were isolated
 * from one another (campaign decision E2). Contract-identical copies, but the
 * point of collapsing them is that they cannot DRIFT: the day "configured"
 * grows a condition — an OAuth token, a reachability probe — a re-inlined copy
 * silently keeps the old rule and hides or ships a tool against it.
 *
 * It lives HERE, next to getImapConfig(), rather than in any tool file: it is a
 * property of the config store, not of any one tool, and putting it in one of
 * the tool files would make the other tool files import a sibling for a rule
 * neither of them owns. No new module — this one already exists for exactly
 * this concern.
 *
 * A named function, not an inline arrow, so `tool.available` is REFERENTIALLY
 * the same object across all consumers and a re-inlined copy is detectable.
 * Deliberately NOT memoized: getImapConfig() re-reads ~/.lax/email.json on
 * every call so a mailbox the user just configured is usable immediately (see
 * tool-search.ts on why the availability pass is not cached).
 */
export function imapConfigured(): boolean {
  return typeof getImapConfig() !== "string";
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
