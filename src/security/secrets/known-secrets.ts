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
// classifier (data-lineage/paths.ts isSensitivePath / extractSensitivePaths…),
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

// The directories the app projects a worker's credentials into, as plaintext
// files the worker needs: the per-op root under the data dir
// (`<laxDir>/cr/<op>/secrets/`, written by canonical-loop/
// container-runtime-projection.ts, which imports these names) and its mount
// inside the container. Every file under either is secret material — the
// provider key, the audit seed, the bootstrap — whatever it is called, so the
// gate matches the directory, not a basename list a new file could miss.
export const PROJECTION_ROOT_DIRNAME = "cr";
export const PROJECTION_SECRETS_DIRNAME = "secrets";
export const CONTAINER_SECRETS_MOUNT = "/run/lax-secrets";

/** Whether `rel`, a path's lowercased segments BELOW the data dir, names a
 *  file under a projection's secrets dir: `cr/<op>/secrets/<file>`. */
export function isProjectedSecretsRelPath(rel: readonly string[]): boolean {
  return rel.length > 3 && rel[0] === PROJECTION_ROOT_DIRNAME && rel[2] === PROJECTION_SECRETS_DIRNAME;
}

/** Whether `segments`, an absolute path's segments, names a file under the
 *  container's secrets mount. */
export function isContainerSecretsMountPath(segments: readonly string[]): boolean {
  const mount = CONTAINER_SECRETS_MOUNT.split("/").filter(Boolean);
  return segments.length > mount.length && mount.every((s, i) => segments[i]?.toLowerCase() === s);
}

// In-memory registry of secret plaintext values to detect/scrub from any
// content heading off-box, each with who vouches for it. A vault entry
// registers under its own source (`vault:<name>`) and withdraws it when the
// entry is deleted or its value replaced — the user retracting "this is a
// secret". Everything else (the operator token, a browser fill, a clipboard
// write, a value masked out of tool output) registers as `seen` and stays for
// the process: once a value has been treated as a secret in one channel it is
// one in every channel, every session. A value leaves the registry only when
// no source still vouches for it.
const SEEN = "seen";
const REGISTERED = new Map<string, Set<string>>();

// ── JSON-escaped renderings ──────────────────────────────────────────────
//
// Redaction matches the secret's BYTES, so a producer that re-encodes its
// output slides a registered secret straight past it. That is not theoretical:
// browser.layout_report's page script serializes every non-ASCII code point
// plus `<`, `>`, `[` and the control chars as a \uXXXX escape, so a secret
// containing any of those characters reached the model unredacted — the
// encoding changed underneath a byte matcher. The fix belongs here, at the
// redaction boundary: each registered value is matched against its plaintext
// form AND against the JSON-escaped renderings THIS codebase produces.
//
// SCOPE — stated honestly. This covers JSON string / \uXXXX escaping ONLY:
//   - plaintext;
//   - `JSON.stringify(v).slice(1,-1)` (backslash, quote, the short escapes for
//     backspace/tab/newline/formfeed/return, and the other control chars,
//     which JSON.stringify writes as a 6-char escape);
//   - that, plus the producer's extra class (`<`, `>`, `[`, and every code
//     unit at or above U+007F) forced to \uXXXX — the layout-report rendering;
//   - every code unit as \uXXXX (a maximally-escaped serializer).
// It does NOT cover arbitrary re-encodings — base64, URL/percent-encoding,
// HTML entities, quoted-printable, per-character splitting or interleaving.
// Those are unfixable by substring matching and are explicitly out of scope
// here; the secret SCANNER (secret-decode-engine.ts / secret-normalize.ts) is
// the layer that peels and normalizes those.
//
// The producer class below is a local copy of layout-report.ts's
// LAYOUT_REPORT_JSON_ESCAPE, deliberately NOT imported: this security leaf must
// not depend on browser code. The two are pinned by the end-to-end test in
// test/browser-layout-report-adversarial.test.ts, which runs the real script
// through the real wrapper and asserts the secret appears in no form.

/** The extra class the layout-report serializer forces to \uXXXX. */
function isProducerEscaped(code: number): boolean {
  return code === 0x3c /* < */ || code === 0x3e /* > */ || code === 0x5b /* [ */ || code >= 0x7f;
}

const hex4 = (code: number): string => "\\u" + code.toString(16).padStart(4, "0");

/** Every rendering of `value` we match, plaintext first, de-duped. */
function matchVariants(value: string): string[] {
  // JSON.stringify's own escaping. Its output is ASCII-safe for the escapes it
  // writes, so the producer pass below only rewrites characters it left literal.
  const json = JSON.stringify(value).slice(1, -1);
  let producer = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    producer += isProducerEscaped(code) ? hex4(code) : json[i];
  }
  let all = "";
  for (let i = 0; i < value.length; i++) all += hex4(value.charCodeAt(i));
  return [...new Set([value, json, producer, all])];
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
// A \uXXXX run inside a variant matches case-insensitively on its hex digits
// (the layout-report script emits lowercase, and so does JSON.stringify, but a
// different serializer may not). Everything else matches EXACTLY — we do NOT
// make the secret itself case-insensitive.
const ESCAPE_RUN = /\\u[0-9a-fA-F]{4}/y;

function variantToPatternSource(variant: string): string {
  let src = "";
  let i = 0;
  while (i < variant.length) {
    ESCAPE_RUN.lastIndex = i;
    const run = ESCAPE_RUN.exec(variant);
    if (run) {
      src += "\\\\u";
      for (const digit of run[0].slice(2).split("")) {
        src += /[a-fA-F]/.test(digit)
          ? `[${digit.toLowerCase()}${digit.toUpperCase()}]`
          : digit;
      }
      i += 6;
      continue;
    }
    src += variant[i].replace(REGEX_META, "\\$&");
    i += 1;
  }
  return src;
}

/** A registered value plus the compiled matcher over all of its renderings. */
export interface KnownSecretMatcher {
  /** The registered plaintext value. */
  value: string;
  /** Global regex matching the plaintext AND every JSON-escaped rendering. */
  pattern: RegExp;
}

// Precomputed at registration — registered secrets are few and redaction runs
// over every piece of external content, so the variants and their regex are
// built once here rather than rebuilt on each call.
const SECRET_MATCHERS = new Map<string, KnownSecretMatcher>();

function buildMatcher(value: string): KnownSecretMatcher {
  const source = matchVariants(value).map(variantToPatternSource).join("|");
  return { value, pattern: new RegExp(source, "g") };
}

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
// An email address names an account; it is not a credential. A login email
// sits in the vault beside its password, and registering it refused the agent
// typing the user's own address into a login form (2026-10-04). Addresses only:
// a URL can be the credential itself (a webhook URL), so URLs stay registered.
const EMAIL_ADDRESS_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i;

export function isEmailAddress(value: string): boolean {
  return EMAIL_ADDRESS_RE.test(value.trim());
}

export function isSecretShaped(value: string): boolean {
  if (value.length < 6) return false; // too short to be a real secret (port/PIN guard)
  if (/^\d+$/.test(value)) return false; // purely numeric → ports, PINs, ids
  const distinct = new Set(value).size;
  if (distinct < 4) return false; // low entropy (e.g. "aaaaaaaa", "abababab")
  return true;
}

/** Register a plaintext value to detect/redact from any outgoing content.
 *  `source` names who vouches for it (see REGISTERED); omitted, it is `seen`. */
export function registerRedactedSecretValue(value: string, source = SEEN): void {
  if (value && isSecretShaped(value) && !isEmailAddress(value)) {
    const sources = REGISTERED.get(value) ?? new Set<string>();
    sources.add(source);
    REGISTERED.set(value, sources);
    if (!SECRET_MATCHERS.has(value)) SECRET_MATCHERS.set(value, buildMatcher(value));
  }
}

/** Withdraw one source's claim on a value; the value stays registered while
 *  any other source still vouches for it. */
export function unregisterRedactedSecretValue(value: string, source = SEEN): void {
  const sources = REGISTERED.get(value);
  if (!sources) return;
  sources.delete(source);
  if (sources.size > 0) return;
  REGISTERED.delete(value);
  SECRET_MATCHERS.delete(value);
}

/** The source a vault entry registers its value under. */
export function vaultSecretSource(name: string): string {
  return `vault:${name}`;
}

/**
 * Snapshot the registered values, longest-first. Longest-first lets callers
 * match/redact the most specific value when one secret is a substring of
 * another, and de-dupe overlapping spans deterministically.
 */
export function knownSecretValues(): string[] {
  return [...REGISTERED.keys()].sort((a, b) => b.length - a.length);
}

/**
 * The matchers for every registered value, longest value first (same ordering
 * rationale as knownSecretValues). Each matcher's pattern covers the plaintext
 * AND the JSON-escaped renderings this codebase produces — see the SCOPE note
 * above for what is deliberately NOT covered.
 */
export function knownSecretMatchers(): KnownSecretMatcher[] {
  return knownSecretValues().map((value) => SECRET_MATCHERS.get(value) ?? buildMatcher(value));
}

/** Whether any known values are registered (cheap fast-path guard). */
export function hasKnownSecretValues(): boolean {
  return REGISTERED.size > 0;
}
