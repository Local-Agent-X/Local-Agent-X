// ═══════════════════════════════════════════════════════════════════
// DATA CLASSIFICATION — Tag tool results with sensitivity labels
// ═══════════════════════════════════════════════════════════════════

export type DataLabel =
  | "credentials"     // API keys, tokens, passwords
  | "pii"            // Names, emails, phone numbers, addresses
  | "secrets"        // Encryption keys, private keys
  | "financial"      // Credit card numbers, bank accounts
  | "internal_path"  // Internal file paths, system info
  | "code";          // Source code

export interface DataClassification {
  labels: DataLabel[];
  confidence: number; // 0.0 - 1.0
}

/** Luhn (mod-10) check on a candidate card number (separators allowed).
 *  Digit-prefix regexes alone match phone-ish/ID-ish 16-digit runs; the
 *  checksum is what separates a real PAN from noise. */
export function luhnValid(candidate: string): boolean {
  const s = candidate.replace(/[\s-]/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ── Is a key-value credential ASSIGNMENT carrying a live secret? ──
//
// `token: <value>` is evidence only when <value> is a real secret. In app source
// the identical shape is overwhelmingly a DECLARATION: an env reference
// (`token: process.env.CLOVER_TOKEN`), a schema (`password: z.string().min(8)`),
// a placeholder (`apiKey: "YOUR_API_KEY_HERE"`), or a literal `undefined`.
//
// Measured 2026-07-29: 8 of 12 realistic source lines tripped the unguarded
// pattern, and each hit scores credential_in_output (30) — on its own enough to
// restrict the SESSION's entire external access (13 such blocks in three days,
// while the agent was building an app around a Clover connector whose source is
// naturally thick with these).
//
// Deliberately scoped to the SCORING classifier. The REDACTION catalog
// (security/secrets/credential-patterns.ts) keeps the unguarded shape on purpose:
// masking a placeholder costs nothing, whereas missing a real secret there is a
// leak. Here the asymmetry is reversed — a false positive costs the session its
// network — so the guard belongs on this side of the seam and NOT on that one.
const CREDENTIAL_VALUE_NOT_LIVE: RegExp[] = [
  /^\$/,                                        // $VAR
  /^%[\w.]+%$/,                                 // %VAR%
  /\$\{/,                                       // ${...} interpolation
  /process\.env\./i,                            // node env reference
  /os\.environ/i,                               // python env reference
  /^["']?<[^>]*>["']?,?$/,                      // <your-key>
  /^["']?(?:undefined|null|true|false|none|nil|empty)["']?,?$/i,
  /\[redacted\]|\*{3,}|x{8,}/i,                 // already masked
  // Placeholder words must ANCHOR at the value start (after an optional quote),
  // never match mid-value: an unanchored /your/ excused the real-shaped
  // `token: "sk_live_yourcompany_9f8e7d6c5b4a"`, turning a false-positive fix
  // into a miss. A placeholder announces itself at the front
  // ("YOUR_API_KEY_HERE", "REPLACE_ME_...", "changeme-...").
  /^["']?(?:your|replace[_-]?me|change[_-]?me|placeholder|example|dummy|todo|fixme|insert[_-])/i,
  // A CALL expression — `z.string().min(8)`, `getToken()`. Anchored on an
  // identifier immediately before `(` so a real secret that merely CONTAINS a
  // paren (`Tr0ub4dor&3(x)`) is not excused.
  /[A-Za-z_$][\w.$]*\(/,
];

/**
 * True when a Key-Value credential match's VALUE could be a live secret, as
 * opposed to a reference, schema, placeholder or already-masked value. Used as
 * the `validate` hook on the key-value pattern below (same mechanism Luhn uses
 * for card numbers: narrow with a regex, confirm with a predicate).
 */
export function isLiveCredentialAssignment(match: string): boolean {
  const sep = match.search(/[:=]/);
  const value = (sep === -1 ? match : match.slice(sep + 1)).trim();
  if (!value) return false;
  return !CREDENTIAL_VALUE_NOT_LIVE.some((p) => p.test(value));
}

const CLASSIFICATION_PATTERNS: Array<{ label: DataLabel; pattern: RegExp; confidence: number; validate?: (match: string) => boolean }> = [
  // Credentials
  { label: "credentials", pattern: /\b(sk-|ghp_|github_pat_|xox[bpas]-|glpat-|AKIA|Bearer\s+[A-Za-z0-9])/i, confidence: 0.95 },
  // `g` flag is required: validated entries are scanned via matchAll, so one
  // placeholder can't mask a real assignment later in the same content.
  { label: "credentials", pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',]{8,}/gi, confidence: 0.85, validate: isLiveCredentialAssignment },
  { label: "credentials", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/, confidence: 0.95 },  // Google API key
  { label: "credentials", pattern: /\b(ya29\.[0-9A-Za-z_-]+)\b/, confidence: 0.9 },     // Google OAuth token
  { label: "credentials", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, confidence: 0.85 },  // JWT
  // PII
  { label: "pii", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i, confidence: 0.8 },
  { label: "pii", pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/, confidence: 0.7 },           // US phone
  { label: "pii", pattern: /\b\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/, confidence: 0.7 },  // International phone
  { label: "pii", pattern: /\(\d{3}\)\s*\d{3}[-.]?\d{4}\b/, confidence: 0.75 },           // (234) 567-8900
  { label: "pii", pattern: /\b\d{3}-\d{2}-\d{4}\b/, confidence: 0.95 },                   // SSN
  // Secrets — expanded PEM types
  { label: "secrets", pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/, confidence: 0.99 },
  { label: "secrets", pattern: /-----BEGIN\s+CERTIFICATE-----/, confidence: 0.8 },
  { label: "secrets", pattern: /-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/, confidence: 0.99 },
  // Financial — issuer-prefix regex narrows the candidates, Luhn confirms.
  // (The 'g' flag is required: validated entries are scanned via matchAll so
  // one non-Luhn candidate can't mask a real PAN later in the content.)
  { label: "financial", pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, confidence: 0.85, validate: luhnValid },
  { label: "financial", pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g, confidence: 0.8, validate: luhnValid },  // Spaced card numbers
  { label: "financial", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, confidence: 0.85 },         // IBAN (uppercase: CC + check digits + BBAN)
  // Internal paths
  { label: "internal_path", pattern: /[/\\]\.ssh[/\\]|[/\\]\.aws[/\\]|[/\\]\.env\b/i, confidence: 0.9 },
  { label: "internal_path", pattern: /[/\\]etc[/\\](passwd|shadow|hosts)\b/i, confidence: 0.9 },
];

/** Classify the content of a tool result */
export function classifyData(content: string): DataClassification {
  const labels = new Set<DataLabel>();
  let maxConfidence = 0;

  for (const { label, pattern, confidence, validate } of CLASSIFICATION_PATTERNS) {
    let hit: boolean;
    if (validate) {
      hit = false;
      for (const m of content.matchAll(pattern)) {
        if (validate(m[0])) {
          hit = true;
          break;
        }
      }
    } else {
      hit = pattern.test(content);
    }
    if (hit) {
      labels.add(label);
      maxConfidence = Math.max(maxConfidence, confidence);
    }
  }

  return { labels: Array.from(labels), confidence: maxConfidence };
}

/** Remove EXTERNAL_UNTRUSTED_CONTENT blocks (whole, and a truncated trailing
 *  one) from a tool result. The threat engine classifies credential/secret
 *  LEAK evidence on the stripped text: credential-shaped strings inside inbound
 *  third-party content — an API-doc page thick with `Bearer <token>` and
 *  example keys is the classic case — are the SITE's content, not the session
 *  leaking its own secret, so they must not latch the session into restriction.
 *  A local secret-file read (never wrapped) still classifies and scores, and a
 *  real session secret returning in a response is caught separately as a canary. */
export function stripExternalUntrusted(content: string): string {
  return content
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>/g, " ")
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>[\s\S]*$/, " ");
}
