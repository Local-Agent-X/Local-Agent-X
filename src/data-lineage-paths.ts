/**
 * Data Lineage — sensitive-path & secret detection (stateless)
 *
 * The shape-based classifiers that decide whether a file path is sensitive
 * (read-taint or attachment sink), whether text contains secret-shaped spans,
 * and how to redact them. Pure functions — no per-session state lives here;
 * callers feed results into the taint registry (data-lineage-taint.ts).
 */

import { homedir } from "node:os";
import { scanForSecrets } from "./security/secret-scanner.js";
import { getLaxDir } from "./lax-data-dir.js";

// Basenames that are credential files regardless of where they live on disk.
// Match is case-insensitive but exact — `secrets.json` matches, `mysecrets.json`
// and `secrets.py` do not.
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  // Shell / package auth dotfiles.
  ".env", ".envrc", ".npmrc", ".pypirc", ".netrc",
  // SSH private keys (canonical algorithm names).
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  // Generic credential / secrets files.
  "auth.json",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  "credentials.json", "credentials.db",
  // Windows DPAPI-protected master keys (Chromium, etc.).
  "master.dpapi", "master.key",
  // Git stored-credentials (plaintext https creds).
  ".git-credentials",
  // gcloud Application Default Credentials (refresh token / SA key, plaintext).
  "application_default_credentials.json",
  // Postgres / MySQL client password files.
  ".pgpass", ".my.cnf",
  // Databricks CLI config (host + PAT token).
  ".databrickscfg",
]);

// Suffix matches for key material containers. Endpoint-anchored, so a
// `notes.key.md` file doesn't trip on `.key`.
const SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [
  ".pem", ".key", ".p12", ".pfx", ".keystore", ".keychain-db",
];

// (parent-directory, basename) pairs. The file is sensitive only when its
// immediate parent directory has the named identity — so `~/.aws/credentials`
// trips, but `~/notes/credentials` does not, and a stray `config` file is
// only flagged inside a known config-dir (.ssh, .aws, .kube).
const DIR_SCOPED_FILES: ReadonlyArray<readonly [string, string]> = [
  [".aws", "credentials"],
  [".aws", "config"],
  [".ssh", "config"],
  [".docker", "config.json"],
  [".kube", "config"],
  // gcloud + gh credential stores live under ~/.config/<tool>/...
  ["gcloud", "credentials.db"],
  ["gcloud", "access_tokens.db"],
  ["gh", "hosts.yml"],
  // rclone remote configs hold cloud-storage tokens/keys.
  ["rclone", "rclone.conf"],
  // sops age keys.txt: ~/.config/sops/age/keys.txt — parent dir is `age`.
  ["age", "keys.txt"],
];

// Directories whose entire contents are credential material. Any file at any
// depth inside one of these is flagged — matched mid-path, not just as a
// basename's parent. `.gnupg` is the GPG home. `legacy_credentials` is gcloud's
// per-account OAuth store (~/.config/gcloud/legacy_credentials/<acct>/adc.json):
// the old `["gcloud","legacy_credentials"]` DIR_SCOPED_FILES rule was DEAD — it
// expected `legacy_credentials` as a BASENAME, but the real layout has it as a
// mid-path directory, so every adc.json under it slipped through.
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".gnupg", "legacy_credentials"]);

function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Check if a file path is sensitive (triggers taint on read).
 *
 * Matches by file shape, NOT by substring. The prior implementation used
 * unanchored patterns like `/password/i` and `/credentials/i` that fired on
 * `password_audit.log`, `tokenizer.py`, and any README mentioning secrets —
 * generating enough false positives that users stopped trusting the gate.
 * This version anchors on basename, extension, or known credential-directory
 * locations only.
 */
export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  if (SENSITIVE_BASENAMES.has(base)) return true;
  // `.env.local`, `.env.production`, etc. Open-ended, so not in the basename set.
  if (base.startsWith(".env.")) return true;
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  if (segsLower.length >= 2) {
    const parent = segsLower[segsLower.length - 2];
    for (const [dir, name] of DIR_SCOPED_FILES) {
      if (parent === dir && base === name) return true;
    }
  }

  for (const seg of segsLower) {
    if (SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  return false;
}

// --- Egress-attachment sink: stricter than the read-taint predicate above ---
//
// `isSensitivePath` is the READ-TAINT predicate: reading a matching file taints
// the session. It is deliberately NARROW (anchored basenames / extensions /
// known cred-dir pairs) because over-flagging there causes taint storms —
// the app reads its own `.lax` data dir and routine `.enc`/key files constantly,
// and tainting on each would block every subsequent egress. The existing spec
// table even encodes that `.ssh/known_hosts`, `.ssh/*.pub`, etc. are NOT tainted.
//
// The email-attachment sink has the opposite risk profile: a file is read AND
// shipped off-box, so a miss is an exfiltration. Here we err toward blocking.
// This predicate is a SUPERSET of `isSensitivePath` plus whole-directory rules
// for the app's own secrets dir and common credential stores. It is used ONLY by
// the attachment guard (http-egress-guard.ts), never for read-taint.

// Directories whose entire contents are off-limits to attach. Any file at any
// depth inside one of these is sensitive for the attachment sink.
// `.lax` (the app's own secrets/vault dir) plus the canonical credential stores.
const ATTACHMENT_SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([
  ".gnupg", ".ssh", ".aws", ".lax",
  // gcloud config dir holds ADC, legacy_credentials, db token stores — the whole
  // tree is off-limits as an attachment (stricter than read-taint, which only
  // flags the specific known stores to avoid tainting benign gcloud config).
  "gcloud",
  // sops age key dir + rclone config dir.
  "age", "rclone",
]);

// Basenames/extensions that signal an encrypted vault or key container and must
// never leave as an attachment. Supplements SENSITIVE_EXTENSIONS (.pem/.key/...).
const ATTACHMENT_SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [".enc"];

// Inside `.ssh`, these are low-risk and may be attached (host fingerprints,
// public keys). Everything else under `.ssh` is a potential private key with an
// arbitrary filename, so it is blocked. NB: `.ssh/config` is intentionally NOT
// listed — `isSensitivePath` already flags it (DIR_SCOPED_FILES), and it can
// reference IdentityFile/ProxyCommand secrets, so blocking it is correct.
const SSH_BENIGN_BASENAMES: ReadonlySet<string> = new Set([
  "known_hosts", "known_hosts.old", "authorized_keys",
]);

/**
 * Stricter sensitive-path check for the egress-attachment sink (email_send
 * attachments, etc.). Returns true if attaching this file would ship credential
 * or secret material off-box.
 *
 * Superset of {@link isSensitivePath}, plus:
 *  - any file under `.ssh` / `.aws` / `.lax` / `.gnupg` (whole-dir), EXCEPT a
 *    short allowlist of benign `.ssh` files (`known_hosts`, `config`, `*.pub`);
 *  - the resolved LAX data dir basename, so a relocated `LAX_DATA_DIR` (a dir not
 *    literally named `.lax`) is still covered;
 *  - `.enc` containers (e.g. the `secrets.enc` vault).
 *
 * Segment-based matching, so `~/.lax/secrets.enc`, `/Users/x/.lax/secrets.enc`,
 * and a `LAX_DATA_DIR`-relocated dir all resolve identically — a leading `~`
 * does not need expansion to match a directory-name segment.
 */
export function isSensitiveAttachmentPath(filePath: string): boolean {
  if (!filePath) return false;
  // The narrow read-taint predicate already covers the anchored cases
  // (.env, id_rsa, *.pem, .aws/credentials, .gnupg/*, ...).
  if (isSensitivePath(filePath)) return true;

  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  // Whole-directory rules. `.ssh` is handled separately (benign-file allowlist).
  for (const seg of segsLower) {
    if (seg === ".ssh") {
      if (base.endsWith(".pub")) return false;
      if (SSH_BENIGN_BASENAMES.has(base)) return false;
      return true;
    }
    if (ATTACHMENT_SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  // Relocated LAX data dir (LAX_DATA_DIR points at a dir not named `.lax`).
  const laxBase = pathSegments(getLaxDir()).pop()?.toLowerCase();
  if (laxBase && segsLower.includes(laxBase)) return true;

  // Encrypted vault containers (e.g. secrets.enc).
  for (const ext of ATTACHMENT_SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  return false;
}

// Shell metacharacters that separate tokens we care about. We intentionally
// keep this conservative — false positives here mean a legitimate http call
// gets blocked, which is worse than missing an exotic obfuscation.
const SHELL_SPLIT_RE = /[\s|<>;()&]+/;

function looksLikePathToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("/")) return true;
  if (token.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  // Relative or bare token with a separator — only treat as path if it has
  // a dot or recognisable directory segment so things like `echo foo/bar`
  // (no extension, no leading dot) don't false-positive on the `.ssh`
  // pattern when the substring happens to appear.
  if ((token.includes("/") || token.includes("\\")) && /\./.test(token)) return true;
  return false;
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

// Max bytes scanned for secrets. Larger inputs are sliced; missed taint on a
// >256KB response is acceptable (rare) and bounded scan keeps the regex pass
// cheap on huge stdout dumps.
const SECRET_SCAN_CAP = 256 * 1024;

/**
 * Scan text (bash stdout, http response body, web fetch body) for secret-shaped
 * substrings. Returns `kinds` (canonical pattern names) only — NEVER the matched
 * value, so logging the result can't leak the secret. `kinds` is informational
 * (taint-target label / log line); no downstream logic keys on specific strings.
 *
 * A pure adapter over the canonical scanForSecrets (security/secret-scanner.ts):
 * taint, redaction and the http egress guard share ONE catalog
 * (credential-patterns.ts) so they can never drift on "what is a secret". The
 * former supplemental set (Google/OpenAI-scoped keys, JWTs, bare PEM markers)
 * now lives in that catalog.
 *
 * Caller responsibility: if `matched` is true, call recordSensitiveRead with
 * source "secret" to taint the session.
 */
export function detectSecretsInOutput(text: string): { matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { matched: false, kinds: [] };
  const slice = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const kinds = new Set<string>();

  for (const m of scanForSecrets(slice).matches) {
    kinds.add(m.pattern);
  }

  return { matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Redact secret-shaped substrings IN PLACE, returning the cleaned text + kinds.
 *
 * Unlike {@link detectSecretsInOutput} (report-only, caller taints the session),
 * this surgically replaces each matched span with `[redacted-secret:<kind>]` so
 * the surrounding content survives. Used for UNTRUSTED INBOUND content
 * (web_fetch / http_request bodies): a secret-shaped span there is coincidental
 * or an injection attempt, not a secret this system owns — so we strip it from
 * the model's view (no echo/exfil) WITHOUT discarding the whole page or tainting
 * egress. Owned-secret reads (local fs / bash / sql) keep the heavier
 * detect→taint→full-redact path.
 */
export function redactSecretSpans(text: string): { text: string; matched: boolean; kinds: string[] } {
  if (!text || typeof text !== "string") return { text: text ?? "", matched: false, kinds: [] };
  // Bounded scan, mirroring detectSecretsInOutput: redact within the cap, pass
  // the tail through unchanged (a missed secret past 256KB is the accepted edge).
  const head = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const tail = text.length > SECRET_SCAN_CAP ? text.slice(SECRET_SCAN_CAP) : "";
  const kinds = new Set<string>();

  // Collect every span to redact from the canonical scanner (one catalog).
  // Replace end-to-start so earlier replacements don't invalidate later indices.
  const spans: Array<{ start: number; end: number; kind: string }> = [];
  for (const m of scanForSecrets(head).matches) {
    spans.push({ start: m.startIndex, end: m.endIndex, kind: m.pattern });
  }

  // Drop spans fully contained in an earlier (kept) span so overlapping
  // catalog matches don't double-redact the same bytes.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof spans = [];
  let coveredTo = -1;
  for (const s of spans) {
    if (s.start >= coveredTo) {
      kept.push(s);
      coveredTo = s.end;
    } else if (s.end > coveredTo) {
      // Partial overlap (different pattern extends further): keep, advance cover.
      kept.push(s);
      coveredTo = s.end;
    }
  }

  let out = head;
  for (const s of [...kept].sort((a, b) => b.start - a.start)) {
    kinds.add(s.kind);
    out = out.slice(0, s.start) + `[redacted-secret:${s.kind}]` + out.slice(s.end);
  }
  return { text: out + tail, matched: kinds.size > 0, kinds: [...kinds] };
}

/**
 * Scan a shell command for path-like tokens that match isSensitivePath.
 * Returns matched paths (deduped, original token form post-quote-strip
 * pre-tilde-expansion — callers should re-check with isSensitivePath if
 * they care about the resolved form).
 *
 * Conservative by design: only fires on tokens that clearly look like
 * filesystem paths (leading `/`, `~`, drive letter, or separator+dot).
 */
export function extractSensitivePathsFromCommand(command: string): string[] {
  if (!command) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const raw of command.split(SHELL_SPLIT_RE)) {
    if (!raw) continue;
    // Strip a trailing `>` or `,` that some shells leave attached; we already
    // split on most metachars but redirects like `2>file` split to `file`.
    const token = stripQuotes(raw);
    if (!looksLikePathToken(token)) continue;
    const expanded = expandTilde(token);
    if (!isSensitivePath(expanded)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    matches.push(token);
  }
  return matches;
}
