/**
 * Secret scanner — decode/normalize evasion engine.
 *
 * The decoders, the peel that turns every encoded run in a text into every
 * text view it can be decoded to (all layers), the budget that bounds that
 * work, and the encoded-view credential pass. Consumed by secret-normalize.ts
 * (known-value pass) and the scan driver in secret-scanner.ts, which peel ONCE
 * per scan and hand the same peel to every pass (docs/adr/0006).
 *
 * Threat model, in one paragraph: the payload is written by a model that may be
 * prompt-injected and holds a secret. It controls every byte — encodings,
 * nesting depth, filler, ordering, size. The scan must either SEE every decoded
 * view of every encoded run, or say so: a run whose views the budget could not
 * cover is reported as an "uninspected" match spanning the run, so `clean` is
 * false and every caller (redaction, taint, the egress block, the known-value
 * block) treats it exactly like a found secret. Nothing the attacker can put in
 * the payload buys silence; the most it buys is a block of its own payload.
 */

import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { type CharRun, hexWordRuns, isAnyBase64Char, maximalRuns, paddedClassRuns } from "./char-runs.js";

export interface SecretMatch {
  type: string;
  pattern: string;
  value: string;
  masked: string;
  startIndex: number;
  endIndex: number;
  /** Span of the secret VALUE itself within the text, when the match can name
   *  it (a catalog capture group, an entropy run). Absent for whole-span
   *  matches — a PEM block, a decoded/normalized view, a known value. */
  valueStart?: number;
  valueEnd?: number;
  /** Presence-only match carrying none of the secret's bytes (CredentialPattern.marker). */
  marker?: true;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ── Anchor-relaxed catalog for DERIVED (decoded/normalized-byte) views ─────────
//
// C3-19: many catalog regexes start with `\b` (word boundary). On the RAW text
// that anchor is essential to keep false positives near zero on normal prose.
// But on a DERIVED view we reconstruct — a decoded buffer, a swapped-endian
// utf16le interpretation — the surrounding bytes are attacker-chosen noise, so
// an attacker can prepend one word char before `sk-ant` (`base64(utf16le("x"+KEY))`):
// the leading `x` re-breaks the `\b` that precedes `sk-ant`, and the derived view
// is `xsk-ant-…` which the `\b`-anchored regex misses. For derived views ONLY we
// strip a leading `\b` from each pattern so the prefix byte can't mask the key.
// This DOESN'T explode FPs because (a) it runs only on reconstructed bytes already
// gated by decode round-trips / normalization, never raw prose, and (b) the
// pattern body itself (`sk-ant-…{20,}`, `AKIA…{16}`, an `eyJ…` JWT triple) is the
// discriminating signal — the `\b` was a cheap pre-filter, not the security.
const DERIVED_VIEW_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> =
  CREDENTIAL_PATTERNS.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex.source.replace(/^\\b/, ""), p.regex.flags),
  }));

// The first catalog shape a DERIVED view trips, by name: the anchor-relaxed
// catalog, so a synthetic prefix byte can't hide a key behind a broken `\b`.
function firstMatchNameDerived(text: string): string | undefined {
  for (const pattern of DERIVED_VIEW_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      pattern.regex.lastIndex = 0;
      return pattern.name;
    }
  }
  return undefined;
}

// ── Decoders ────────────────────────────────────────────────────────────────

// Don't bother decoding runs shorter than this — a real key is >=20 chars, so
// its encodings are longer; this kills the "base64-decode every short token"
// cost. Mirrors the catalog's >=20-char key floor.
const MIN_BASE64_RUN = 16;
const MIN_HEX_RUN = 32;
const MIN_PERCENT_RUN = 8;

const PERCENT_ESCAPE_RE = /%[0-9a-fA-F]{2}/;

// Decode a base64/base64url run to its raw bytes, applying the normalize +
// round-trip sanity the catalog decode relies on. Returns the Buffer (so
// callers can take MULTIPLE text interpretations of the same bytes) or null
// when the run isn't real base64.
function decodeBase64Buffer(run: string): Buffer | null {
  const normalized = run.replace(/-/g, "+").replace(/_/g, "/");
  const unpadded = normalized.replace(/=+$/, "");
  if (unpadded.length < MIN_BASE64_RUN) return null;
  if (!/^[A-Za-z0-9+/]+$/.test(unpadded)) return null;
  try {
    const buf = Buffer.from(normalized, "base64");
    if (buf.length === 0) return null;
    // Re-encoding round-trip filters out runs that aren't actually base64.
    if (buf.toString("base64").replace(/=+$/, "") !== unpadded) return null;
    return buf;
  } catch {
    return null;
  }
}

// Decode a hex run to its raw bytes, or null when the run isn't clean hex.
function decodeHexBuffer(run: string): Buffer | null {
  if (run.length < MIN_HEX_RUN || run.length % 2 !== 0) return null;
  try {
    const buf = Buffer.from(run, "hex");
    if (buf.length === 0 || buf.length * 2 !== run.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function decodePercent(run: string): string | null {
  if (!run.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(run);
    return decoded === run ? null : decoded;
  } catch {
    return null;
  }
}

// Text interpretations of a decoded buffer's bytes for the catalog + known-value
// passes. A receiver can recover a secret from base64/hex of UTF-16LE bytes
// (`Buffer.from(key,'utf16le').toString('base64'|'hex')`), which the latin1 view
// renders as a NUL-interleaved string — so `decoded.includes(value)` and the
// catalog regexes (which need contiguous chars) both miss it. We additionally
// surface the utf16le view for BOTH byte orders so the recovered key is a
// contiguous run again. swap16 mutates the buffer in place, so decode a fresh
// copy for the second order. Shared by base64 AND hex so the two byte-bearing
// schemes can't drift on "which text interpretations we inspect."
function bufferTextViews(buf: Buffer | null): string[] {
  if (buf === null) return [];
  const views = [buf.toString("latin1"), buf.toString("utf16le")];
  // swap16() requires an even byte length; an odd-length buffer can't be a clean
  // utf16le string in the other byte order, so only the as-decoded order applies.
  if (buf.length >= 2 && buf.length % 2 === 0) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    views.push(swapped.toString("utf16le"));
  }
  return views;
}

// ── Schemes ─────────────────────────────────────────────────────────────────

export type EncodedRun = CharRun;

export interface EncodedScheme {
  label: "base64" | "hex" | "percent";
  /** Every candidate run of this encoding in `text`, in order. */
  runs: (text: string) => EncodedRun[];
  /** Every text view `run` decodes to; [] when it does not decode. */
  views: (run: string) => string[];
}

// Runs are found by walking character codes (char-runs.ts), never by a regex
// over the run: the old percent alternation threw RangeError on ~5 MB, the old
// base64 class on ~7 MB, before any verdict was produced.
const PERCENT = 37;

// Percent runs: within each whitespace-free stretch, the pieces between stray
// `%` signs (a `%` not starting an escape ends a run), kept when they hold at
// least one escape.
function percentRuns(text: string): EncodedRun[] {
  const out: EncodedRun[] = [];
  if (!text.includes("%")) return out;
  const notSpace = (c: number) => (c < 128 ? c !== 32 && (c < 9 || c > 13) : !/\s/.test(String.fromCharCode(c)));
  for (const [tokenStart, tokenEnd] of maximalRuns(text, notSpace)) {
    let start = tokenStart;
    for (let i = tokenStart; i <= tokenEnd; i++) {
      const stray = i < tokenEnd && text.charCodeAt(i) === PERCENT && !PERCENT_ESCAPE_RE.test(text.slice(i, i + 3));
      if (i < tokenEnd && !stray) continue;
      const run = text.slice(start, i);
      if (run.length >= MIN_PERCENT_RUN && PERCENT_ESCAPE_RE.test(run)) out.push({ run, index: start });
      start = i + 1;
    }
  }
  return out;
}

export const ENCODED_SCHEMES: readonly EncodedScheme[] = [
  { label: "base64", runs: (t) => paddedClassRuns(t, isAnyBase64Char, MIN_BASE64_RUN), views: (run) => bufferTextViews(decodeBase64Buffer(run)) },
  { label: "hex", runs: (t) => hexWordRuns(t, MIN_HEX_RUN), views: (run) => bufferTextViews(decodeHexBuffer(run)) },
  { label: "percent", runs: percentRuns, views: (run) => { const d = decodePercent(run); return d === null ? [] : [d]; } },
];

// ── Budget ──────────────────────────────────────────────────────────────────
//
// Total characters of decoded views one scan may materialize (and therefore
// regex-scan), across every run, layer and view. Scales with the input: a fixed
// pool let filler at the front of a payload spend it all before the run that
// carried the key (128 KB of filler hid a base64 key). Every decode shrinks its
// input (base64 to 3/4, hex to 1/2, percent by 2 chars per escape), so a
// pure base64 chain costs at most 6x its length in views (1.5x per layer, as a
// geometric series); 8 per input char covers it with room, and benign content
// measured far below it (docs/adr/0006). The floor keeps small payloads at the
// old fixed pool; the ceiling bounds one scan's CPU and memory.
const DECODE_BUDGET_PER_CHAR = 8;
const MIN_DECODE_BUDGET = 256 * 1024;
const MAX_DECODE_BUDGET = 16 * 1024 * 1024;

export function decodeBudgetFor(textLength: number): number {
  return Math.min(MAX_DECODE_BUDGET, Math.max(MIN_DECODE_BUDGET, DECODE_BUDGET_PER_CHAR * textLength));
}

// ── The peel ────────────────────────────────────────────────────────────────

export interface PeeledRun extends EncodedRun {
  scheme: EncodedScheme;
  /** Every decoded text view under this run, every layer (latin1, both-endian
   *  utf16le, percent text). */
  views: string[];
  /** False when the budget ran out before every layer under this run was
   *  materialized: what it carries is unknown, and the passes say so. */
  complete: boolean;
}

interface Peel {
  /** The run decodes at all: a run that does not carries nothing to inspect. */
  decodes: boolean;
  views: string[];
  complete: boolean;
}

/**
 * Peel one run into every view under it: decode it, then decode every encoded
 * run inside each view, until nothing decodes. Every inner run is taken, never
 * the first or the first N: a cap on how many are looked at is a number of
 * filler runs an attacker prepends (256 runs, about 6 KB, defeated the last
 * one). Identical inner runs within the tree are decoded once. Draws on the
 * scan's shared budget and stops — incomplete — when a decode does not fit.
 */
function peelRun(scheme: EncodedScheme, run: string, budget: { remaining: number }): Peel {
  const views: string[] = [];
  const seen = new Set<string>([`${scheme.label}\0${run}`]);
  const take = (vs: string[]): boolean => {
    let cost = 0;
    for (const v of vs) cost += v.length;
    if (cost > budget.remaining) return false;
    budget.remaining -= cost;
    for (const v of vs) views.push(v);
    return true;
  };
  const outer = scheme.views(run);
  if (outer.length === 0) return { decodes: false, views, complete: true };
  if (!take(outer)) return { decodes: true, views, complete: false };
  // `views` grows while it is walked: each new view's inner runs are taken in turn.
  for (let i = 0; i < views.length; i++) {
    for (const inner of ENCODED_SCHEMES) {
      for (const r of inner.runs(views[i])) {
        const key = `${inner.label}\0${r.run}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!take(inner.views(r.run))) return { decodes: true, views, complete: false };
      }
    }
  }
  return { decodes: true, views, complete: true };
}

/**
 * Every encoded run in `text` that decodes, with every view under it. The ONE
 * peel the catalog pass, the known-value pass and the taint/canary views read,
 * so they cannot drift on encoding handling and the work is done once per scan.
 * A run repeated verbatim is peeled once and reported at each position.
 */
export function peelEncodedRuns(text: string, budget = { remaining: decodeBudgetFor(text.length) }): PeeledRun[] {
  const out: PeeledRun[] = [];
  const memo = new Map<string, Peel>();
  for (const scheme of ENCODED_SCHEMES) {
    for (const r of scheme.runs(text)) {
      const key = `${scheme.label}\0${r.run}`;
      let peel = memo.get(key);
      if (!peel) {
        peel = peelRun(scheme, r.run, budget);
        memo.set(key, peel);
      }
      if (peel.decodes) out.push({ ...r, scheme, views: peel.views, complete: peel.complete });
    }
  }
  return out;
}

/** The match for a run the budget could not cover: not proof of a secret,
 *  proof that the scan cannot vouch for it. Spans the whole run so redaction
 *  removes it, and carries none of its bytes. */
export function uninspectedMatch(p: PeeledRun): SecretMatch {
  return {
    type: "uninspected-encoded",
    pattern: `Uninspected encoded content (${p.scheme.label})`,
    value: "",
    masked: "***",
    startIndex: p.index,
    endIndex: p.index + p.run.length,
  };
}

/**
 * Encoded runs whose DECODED views trip a credential pattern, one SecretMatch
 * per run spanning the ORIGINAL encoded blob (so redaction removes the whole
 * thing), plus an uninspected match per run the budget could not cover.
 * Derived views are matched with the anchor-relaxed catalog.
 */
export function scanEncodedViews(peeled: readonly PeeledRun[]): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const p of peeled) {
    let name: string | undefined;
    for (const decoded of p.views) {
      name = firstMatchNameDerived(decoded);
      if (name) break;
    }
    if (name) {
      out.push({
        type: "obfuscated",
        pattern: `${name} (${p.scheme.label})`,
        value: p.run.slice(0, 20) + (p.run.length > 20 ? "..." : ""),
        masked: maskSecret(p.run),
        startIndex: p.index,
        endIndex: p.index + p.run.length,
      });
    } else if (!p.complete) {
      out.push(uninspectedMatch(p));
    }
  }
  return out;
}
