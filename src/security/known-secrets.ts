/**
 * Known-secret-value registry.
 *
 * The strongest possible secret-egress check is matching the user's ACTUAL
 * stored secret values leaving the box — you KNOW your secrets, so match THEM,
 * not "things that look secret-ish." Near-zero false positives, and (combined
 * with the scanner's decode/normalize views) un-evadable by obfuscation.
 *
 * This module owns the registry + its shape gate so BOTH sanitize.ts (which
 * redacts known values from outbound external content) and secret-scanner.ts
 * (which detects them so the egress guard BLOCKS and the taint path TAINTS) can
 * share ONE source of truth without an import cycle: secret-scanner.ts already
 * imports sanitize.ts, so the registry can't live in sanitize.ts without the
 * scanner reaching across that boundary — it lives here instead, a leaf module
 * neither side depends on transitively.
 *
 * SECURITY: never log, echo, or otherwise emit the registered values.
 */

// ── App-owned at-rest secret/key/seed files ──────────────────────────────
//
// The basenames of the key/seed/vault files THIS app persists under
// getLaxDir(). They are the strongest possible "is this a secret file" signal
// for our OWN files: we KNOW exactly what we write, so we match THOSE basenames
// rather than guessing. This is the ONE canonical enumeration — the read-taint
// classifier (data-lineage-paths.ts isSensitivePath / extractSensitivePaths…),
// the file-access read gate + write block (file-access.ts SENSITIVE_PATTERNS /
// coreProtectedFiles) ALL derive from it so they can never drift apart and
// leave one of our own key files read-untainted or write-unprotected again.
//
// Lives here (a security/ leaf module both detection-layer consumers already
// import, with no dependency on app-runtime) to avoid the layering inversion of
// the detection layer reaching up into audit-signing.ts. A build-time assertion
// (see the keychain/audit tests) pins this set to what the writer modules
// (audit-signing.ts, keychain.ts) actually persist, so a NEW writer that adds a
// key/seed file fails CI until its basename is enrolled here.
//
// SECURITY: enrollment is the gate — adding a writer without adding its
// basename here means that file is neither tainted on read nor write-protected.
export const APP_AT_REST_SECRET_BASENAMES: ReadonlySet<string> = new Set([
  // audit-signing.ts — the HMAC audit seed (legacy plaintext + sealed forms).
  "audit-key",
  "audit-key.enc",
  // keychain.ts — file-fallback salt + the secrets vault + DPAPI/file master keys.
  "secrets.salt",
  "secrets.enc",
  "master.dpapi",
  "master.key",
  // OAuth/credential tokens persisted under the data dir.
  "auth.json",
]);

/**
 * Whether `basename` is one of the app's own at-rest secret/key/seed files
 * (case-insensitive). Pass a bare basename, not a full path.
 */
export function isAppAtRestSecretBasename(basename: string): boolean {
  if (!basename) return false;
  return APP_AT_REST_SECRET_BASENAMES.has(basename.toLowerCase());
}

// In-memory registry of secret plaintext values to detect/scrub from any
// content heading off-box. Populated proactively from the SecretsStore on
// load/add, and lazily by browser_fill_from_secret / clipboard_write.
const REDACTED_SECRET_VALUES = new Set<string>();

/**
 * Gate the registry to plausibly-secret values only.
 *
 * WHY: matching does an unanchored substring check, so registering a short or
 * purely-numeric value (a port like "47831", a 4-digit PIN, a record id) would
 * clobber/flag every benign occurrence of that substring in later output
 * ("listening on 47831" → flagged). Real secrets (API keys, tokens, passwords)
 * are long and mixed, so they sail through this gate.
 *
 * We only TIGHTEN the registration input and deliberately do NOT weaken the
 * matcher (no word boundaries; a genuine secret embedded in a larger token must
 * still be caught).
 */
export function isSecretShaped(value: string): boolean {
  if (value.length < 6) return false; // too short to be a real secret (port/PIN guard)
  if (/^\d+$/.test(value)) return false; // purely numeric → ports, PINs, ids
  const distinct = new Set(value).size;
  if (distinct < 4) return false; // low entropy (e.g. "aaaaaaaa", "abababab")
  return true;
}

/** Register a plaintext value to detect/redact from any outgoing content. */
export function registerRedactedSecretValue(value: string): void {
  if (value && isSecretShaped(value)) REDACTED_SECRET_VALUES.add(value);
}

/** Clear a previously-registered value (e.g. on secret rotation or deletion). */
export function unregisterRedactedSecretValue(value: string): void {
  REDACTED_SECRET_VALUES.delete(value);
}

/**
 * Snapshot the registered values, longest-first. Longest-first lets callers
 * match/redact the most specific value when one secret is a substring of
 * another, and de-dupe overlapping spans deterministically.
 */
export function knownSecretValues(): string[] {
  return [...REDACTED_SECRET_VALUES].sort((a, b) => b.length - a.length);
}

/** Whether any known values are registered (cheap fast-path guard). */
export function hasKnownSecretValues(): boolean {
  return REDACTED_SECRET_VALUES.size > 0;
}
