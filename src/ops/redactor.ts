/**
 * Streaming event redactor.
 *
 * Per spec §3: events.jsonl is a long-term artifact; secrets must never
 * reach it. The redactor runs over every event before disk-append. Two
 * complementary mechanisms:
 *
 *   1. Pattern-based scrubbing — known secret formats (Bearer tokens, API
 *      key prefixes, JWT-like blobs) get redacted regardless of where
 *      they appear in the payload.
 *
 *   2. Event-level sensitive flag — tools can mark their result event
 *      `sensitive: true`. The redactor either drops the payload entirely
 *      (replacing with a `<redacted: sensitive>` stub) or scrubs known
 *      sensitive field names (passwords, secrets, tokens, autofill).
 *
 * Fail-closed policy: if the redactor isn't sure whether a value is a
 * secret, redact. Better to lose detail in disk logs than to leak a key.
 *
 * The original event still streams to the live UI session via WS — only
 * the persisted-to-disk form is redacted. This keeps the developer
 * experience full-fidelity in real-time while keeping the long-term
 * artifact safe.
 */

import type { OpEvent } from "./types.js";

// ── Patterns ───────────────────────────────────────────────────────────────

/**
 * Patterns that match known secret-shaped strings. Each replaces the matched
 * value with a stable redacted form so disk diffs don't suddenly show
 * different masking each run.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  // Bearer / Basic auth headers
  { name: "bearer-header", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}/g, replacement: "$1 <redacted>" },
  // Authorization: <anything> form (catch-all)
  { name: "authorization-line", re: /(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)([^"'\s]{16,})/g, replacement: "$1<redacted>" },
  // Common API key prefixes
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: "sk-<redacted>" },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "sk-ant-<redacted>" },
  { name: "xai-key", re: /\bxai-[A-Za-z0-9_-]{20,}/g, replacement: "xai-<redacted>" },
  { name: "github-token", re: /\bghp_[A-Za-z0-9]{30,}/g, replacement: "ghp_<redacted>" },
  { name: "github-fgpat", re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g, replacement: "github_pat_<redacted>" },
  { name: "stripe-key", re: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{16,}/g, replacement: "$1_$2_<redacted>" },
  // JWT-shaped (three b64url segments with dots)
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "<redacted-jwt>" },
  // Generic 32+ hex / b64-ish blobs that look like keys (last resort)
  // Disabled by default — too aggressive, would scrub commit SHAs and content hashes
];

/**
 * Field NAMES that should always have their value redacted regardless of
 * pattern. Catches the case where a secret doesn't match a known prefix
 * but the surrounding context names it as sensitive.
 */
const SENSITIVE_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "apikey",
  "api_key",
  "apitoken",
  "api_token",
  "token",
  "access_token",
  "refresh_token",
  "auth_token",
  "auth",
  "authorization",
  "cookie",
  "set-cookie",
  "session",
  "session_id",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "ssh_key",
  // Browser autofill (per spec §3 redactor list)
  "autofill_value",
  "autofill",
  // Tool args that shadow the secret store
  "secret_value",
  "secret_data",
]);

const FIELD_REDACTED = "<redacted>";
const SENSITIVE_EVENT_REPLACEMENT = { redacted: true, reason: "sensitive flag set" };

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Redact an event for disk persistence. Returns a NEW event (does not
 * mutate the input — supervisor still streams the original to live WS).
 *
 * The returned event always sets `redacted: true` if any modification
 * happened, so a disk-log reader can tell whether they're seeing the full
 * payload or a stripped one.
 */
export function redactEventForDisk(event: OpEvent): OpEvent {
  // Sensitive flag: drop payload entirely
  if (event.sensitive) {
    return {
      ...event,
      redacted: true,
      payload: { ...SENSITIVE_EVENT_REPLACEMENT, type: event.type, originalKeys: Object.keys(event.payload) },
    };
  }

  // Walk the payload and redact recursively
  const { changed, redactedPayload } = redactValue(event.payload) as { changed: boolean; redactedPayload: Record<string, unknown> };
  if (!changed) return event;
  return { ...event, redacted: true, payload: redactedPayload };
}

/**
 * Redact a free-form string by applying the secret patterns. Useful for
 * log lines that aren't structured events but still go to disk.
 */
export function redactString(s: string): { changed: boolean; redacted: string } {
  let out = s;
  let changed = false;
  for (const { re, replacement } of SECRET_PATTERNS) {
    if (re.test(out)) {
      changed = true;
      out = out.replace(re, replacement);
    }
  }
  return { changed, redacted: out };
}

// ── Recursion ──────────────────────────────────────────────────────────────

interface RedactionResult { changed: boolean; redactedPayload: unknown }

function redactValue(v: unknown, parentKeyName?: string): RedactionResult {
  // String values: pattern-scrub OR replace if parent key is sensitive
  if (typeof v === "string") {
    if (parentKeyName && SENSITIVE_FIELD_NAMES.has(parentKeyName.toLowerCase())) {
      return { changed: true, redactedPayload: FIELD_REDACTED };
    }
    const r = redactString(v);
    return { changed: r.changed, redactedPayload: r.changed ? r.redacted : v };
  }

  // Arrays: recurse into elements
  if (Array.isArray(v)) {
    let anyChanged = false;
    const out = v.map((el, _i) => {
      const r = redactValue(el, parentKeyName);
      if (r.changed) anyChanged = true;
      return r.redactedPayload;
    });
    return { changed: anyChanged, redactedPayload: out };
  }

  // Plain objects: recurse, passing the key name as parent for child values
  if (v && typeof v === "object") {
    let anyChanged = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // If the field NAME itself indicates sensitivity, redact regardless of value type
      if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
        anyChanged = true;
        out[k] = FIELD_REDACTED;
        continue;
      }
      const r = redactValue(val, k);
      if (r.changed) anyChanged = true;
      out[k] = r.redactedPayload;
    }
    return { changed: anyChanged, redactedPayload: out };
  }

  // Numbers, booleans, null, undefined: pass through
  return { changed: false, redactedPayload: v };
}
