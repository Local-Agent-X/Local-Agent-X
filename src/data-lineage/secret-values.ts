/**
 * Data Lineage — secret VALUES in tool output.
 *
 * The model must never see a secret's bytes, and it must never lose the rest
 * of the output that carried them. Both halves of that used to fail in
 * opposite directions: an http_request body had each secret-shaped span
 * replaced by a marker (so the model could not tell WHICH names it had just
 * fetched), while a shell command whose output held one real key had the
 * WHOLE output replaced by a stub (the "eyes turned off" failure — a
 * `supabase secrets list` vanished because one row matched).
 *
 * This module is the one seam that does it right, for every output channel:
 *   - mask each secret VALUE in place (`gho_****`) and keep every name, digest,
 *     label and line around it;
 *   - REGISTER each masked value as a known secret, so the outbound scan
 *     (secret-scanner.ts scanKnownValues — raw, base64/hex/percent-encoded and
 *     unicode-normalized views) blocks it at every egress sink even though the
 *     session is not tainted. The model never saw the bytes, so under the
 *     delivery-point invariant nothing entered context and nothing else is
 *     locked; the registry, not session taint, is what stops the value leaving.
 *
 * Detection is the canonical scanner (one catalog, one entropy pass) — nothing
 * here decides what a secret looks like.
 */

import {
  scanForSecrets,
  scanKnownSecretValues,
  registerRedactedSecretValue,
  isSecretShaped,
  maskForDisplay,
  isMaskedDisplay,
} from "../security/secrets/index.js";
import { SECRET_SCAN_CAP } from "./paths.js";
import { createLogger } from "../logger.js";

const logger = createLogger("data-lineage");

// An endpoint that SERVES secrets — a vault, a project's secrets/credentials
// listing, a key set. The kernel used to quarantine the run on this URL shape
// followed by any POST (pure sequence, no data flow); LAX now uses the same
// shape for what actually protects the values: treating every value the
// endpoint returns as a secret, whether or not it looks like one.
const SECRET_ENDPOINT_URL_RE = /vault|secrets|credentials|\.well-known\/keys/i;

export function isSecretEndpointUrl(url: unknown): boolean {
  return typeof url === "string" && SECRET_ENDPOINT_URL_RE.test(url);
}

// A JSON string field named `value` — the `{name, value}` record shape that
// secrets endpoints (Supabase, Vercel, Doppler, Vault's data map) answer with.
const JSON_VALUE_FIELD_RE = /"value"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

// A value that names a place, not a credential: a URL, a host[:port], an
// address. Secrets stores hold these next to real keys (SUPABASE_URL, a DB
// host). They are masked like every other value the endpoint returned, but
// NOT registered — a registered value is refused at every egress sink, and
// refusing every later request to the project's own URL would brick the work
// the secrets exist for.
const LOCATOR_VALUE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\w.+-]+@[\w-]+(?:\.[\w-]+)+$|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$))/i;

// An endpoint value shorter than this is masked but not registered. The
// registry matches unanchored substrings, so a short value (`us-east-1`,
// `production`) would refuse every later payload that happens to contain it.
// Twelve is the catalog's own bar for a Key-Value credential (credential-
// patterns.ts); a value the scanner itself recognised is registered regardless.
const MIN_REGISTERED_ENDPOINT_VALUE = 12;

export interface MaskOptions {
  /** Mask only credential shapes and registered values; skip the loose
   *  high-entropy pass. For shell output, where a long build hash or a
   *  camelCase identifier must not be turned into `****`. */
  structuredOnly?: boolean;
  /** Mask only registered values (the user's stored secrets, the operator
   *  token, values an earlier mask withheld). For a file read or search, where
   *  a credential-SHAPED string is the content being worked on — a test
   *  fixture's example key — and masking it would break the edit after. */
  knownOnly?: boolean;
  /** The text came from a secrets-serving endpoint (isSecretEndpointUrl):
   *  every JSON `"value"` that could be a secret is one, shape or not. */
  endpoint?: boolean;
}

export interface MaskedSecrets {
  text: string;
  /** How many values were masked. */
  masked: number;
  /** Catalog names of what was masked — never the values. */
  kinds: string[];
  /** The plaintext values, for registration only. Never log or return to the model. */
  values: string[];
}

interface Span { start: number; end: number; replacement: string; value: string | null; kind: string }

function jsonValueSpans(head: string): Span[] {
  const spans: Span[] = [];
  JSON_VALUE_FIELD_RE.lastIndex = 0;
  for (const m of head.matchAll(JSON_VALUE_FIELD_RE)) {
    const raw = m[1];
    if (!raw) continue;
    let value: string;
    try { value = JSON.parse(`"${raw}"`); } catch { continue; }
    // A value this masker already rendered (`corr****`) is shaped enough to
    // pass isSecretShaped; masking it again to `****` would throw the prefix
    // away on the seam's second pass and make the pass non-idempotent.
    if (isMaskedDisplay(value) || !isSecretShaped(value)) continue;
    const start = (m.index ?? 0) + m[0].length - 1 - raw.length;
    spans.push({
      start, end: start + raw.length, replacement: maskForDisplay(value),
      value: LOCATOR_VALUE_RE.test(value) || value.length < MIN_REGISTERED_ENDPOINT_VALUE ? null : value,
      kind: "Secrets Endpoint Value",
    });
  }
  return spans;
}

function scannerSpans(head: string, opts: MaskOptions): Span[] {
  const spans: Span[] = [];
  for (const m of opts.knownOnly ? scanKnownSecretValues(head) : scanForSecrets(head).matches) {
    if (m.marker) continue;
    if (opts.structuredOnly && m.type === "high-entropy-token") continue;
    if (m.valueStart !== undefined && m.valueEnd !== undefined) {
      const value = head.slice(m.valueStart, m.valueEnd);
      spans.push({ start: m.valueStart, end: m.valueEnd, replacement: maskForDisplay(value), value, kind: m.pattern });
      continue;
    }
    // No nameable value (a PEM block, an encoded or normalized view, a
    // registered value): the whole span is the secret. A registered value is
    // already in the registry; an encoded blob is registered as-is so its
    // verbatim form is caught too.
    const value = m.type === "known-secret-value" ? null : head.slice(m.startIndex, m.endIndex);
    spans.push({ start: m.startIndex, end: m.endIndex, replacement: `[redacted-secret:${m.pattern}]`, value, kind: m.pattern });
  }
  return spans;
}

/**
 * Mask every secret value in `text` in place. Pure: registers nothing. The
 * scan is capped like detectSecretsInOutput (the tail past the cap passes
 * through unchanged — the accepted edge for a >256KB output).
 */
export function maskSecretValues(text: string, opts: MaskOptions = {}): MaskedSecrets {
  if (!text || typeof text !== "string") return { text: text ?? "", masked: 0, kinds: [], values: [] };
  const head = text.length > SECRET_SCAN_CAP ? text.slice(0, SECRET_SCAN_CAP) : text;
  const tail = text.length > SECRET_SCAN_CAP ? text.slice(SECRET_SCAN_CAP) : "";

  const spans = [...(opts.endpoint ? jsonValueSpans(head) : []), ...scannerSpans(head, opts)];
  // Earliest start first, longest first on a tie; a span overlapping one
  // already kept is dropped (the full PEM block wins over its BEGIN line, the
  // endpoint value over the shape match inside it).
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let coveredTo = -1;
  for (const s of spans) {
    if (s.start < coveredTo) continue;
    kept.push(s);
    coveredTo = s.end;
  }

  let out = head;
  const kinds = new Set<string>();
  const values = new Set<string>();
  for (const s of [...kept].reverse()) {
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
    kinds.add(s.kind);
    if (s.value !== null) values.add(s.value);
  }
  return { text: out + tail, masked: kept.length, kinds: [...kinds], values: [...values] };
}

/**
 * Mask every secret value in a tool output AND register each one as a known
 * secret, so the outbound scan blocks it at every egress sink. The one call
 * every output channel makes (http_request / web_fetch before their `find`
 * filter, and the delivery seam over every tool result). Idempotent: masked
 * text scans clean, so a second pass changes nothing.
 */
export function withholdSecretValues(text: string, opts: MaskOptions = {}): { text: string; masked: number; kinds: string[] } {
  const r = maskSecretValues(text, opts);
  for (const v of r.values) registerRedactedSecretValue(v);
  if (r.masked > 0) {
    logger.info(`${r.masked} secret value(s) masked before delivery and registered as known secrets (${r.kinds.join(", ")})`);
  }
  return { text: r.text, masked: r.masked, kinds: r.kinds };
}

/** The one-line note appended to an output whose values were masked. */
export function secretsMaskedNote(masked: number, kinds: string[]): string {
  return (
    `[${masked} secret value${masked === 1 ? "" : "s"} masked (${kinds.join(", ")}): the values were withheld from the model context ` +
    `and registered so they cannot be sent off-box. Names and everything else are shown as-is. ` +
    `If a credential is needed, use a {{SECRET_NAME}} placeholder or ask the user.]`
  );
}
