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
import { redactSecrets } from "../security/secret-scanner.js";

// ── Patterns ───────────────────────────────────────────────────────────────

/**
 * Secret-SHAPE scrubbing is delegated to the canonical scanner
 * (security/secret-scanner.ts redactSecrets, backed by credential-patterns.ts
 * CREDENTIAL_PATTERNS). This used to be a ~9-pattern local copy that drifted
 * below the canonical catalog — an event holding a Stripe/Supabase/npm/SendGrid
 * key reached disk un-redacted because the local set didn't know those shapes.
 * Now every catalog shape (all 27) is scrubbed before disk-append.
 *
 * The entries below are NOT secret value-shapes the catalog owns; they stay local:
 *   1. AUTH-HEADER scrubbing by field NAME/context (Bearer/Basic header value,
 *      `authorization: <value>` lines) — a field-name control, not a value-shape
 *      match, mirroring SENSITIVE_FIELD_NAMES below. The canonical "Bearer Token"
 *      shape covers Bearer bodies but not the `Basic ` scheme or the bare
 *      authorization-line form, so this is kept to preserve that coverage.
 *   2. Stripe PUBLISHABLE / restricted keys (`pk_`/`rk_`) — a shape the canonical
 *      catalog doesn't carry. Kept so disk redaction doesn't regress.
 *
 * (JWTs moved INTO the canonical catalog — they're scrubbed by redactSecrets in
 * redactString below, so no local JWT entry is needed here.)
 *
 * Each replaces the matched value with a stable redacted form so disk diffs
 * don't suddenly show different masking each run.
 */
const SUPPLEMENTAL_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  // Bearer / Basic auth headers (field-name/context control, not a value shape)
  { name: "bearer-header", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}/g, replacement: "$1 <redacted>" },
  // Authorization: <anything> form (catch-all, field-name control)
  { name: "authorization-line", re: /(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)([^"'\s]{16,})/g, replacement: "$1<redacted>" },
  // Stripe publishable / restricted keys — canonical only carries sk_live/sk_test.
  { name: "stripe-pub-key", re: /\b(pk|rk)_(test|live)_[A-Za-z0-9]{16,}/g, replacement: "$1_$2_<redacted>" },
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
  // Canonical secret-shape scrub (all 27 catalog shapes) → stable `[REDACTED:name]`.
  let out = redactSecrets(s);
  let changed = out !== s;
  // Supplemental: auth-header/field-name forms + shapes the catalog lacks.
  for (const { re, replacement } of SUPPLEMENTAL_PATTERNS) {
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
