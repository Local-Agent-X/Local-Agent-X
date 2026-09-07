/**
 * Secret scanner — encoded-run detection and per-scheme decoding.
 *
 * The candidate-run regexes (base64/base64url, hex, percent), the decoders for
 * each, and the text interpretations of the bytes they yield. Split out of
 * secret-decode-engine.ts under the 400-LOC gate along a real seam: this file
 * answers "what is an encoded run and what does one decode to", while the engine
 * owns the peel loop and the byte budgets that bound it — so no bound is ever
 * separated from the loop it guards.
 */

// Don't bother decoding runs shorter than this — a real key is >=20 chars, so
// its encodings are longer; this kills the "base64-decode every short token"
// cost. Mirrors the catalog's >=20-char key floor.
const MIN_BASE64_RUN = 16;
const MIN_HEX_RUN = 32;

// Candidate encoded runs: base64/base64url, hex, percent-encoded.
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{32,}\b/g;
const PERCENT_RUN_RE = /(?:%[0-9a-fA-F]{2}|[^\s%]){8,}/g;

// Decode a base64/base64url run to its raw bytes, applying the same
// normalize + round-trip sanity the catalog decode relies on. Returns the
// Buffer (so callers can take MULTIPLE text interpretations of the same bytes)
// or null when the run isn't real base64.
function decodeBase64Buffer(run: string): Buffer | null {
  // Normalize base64url → base64 and length-sanity before decoding.
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

function decodeBase64(run: string): string | null {
  const buf = decodeBase64Buffer(run);
  return buf === null ? null : buf.toString("latin1");
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
  // swap16() needs an even byte length; an odd-length buffer can't be a clean
  // utf16le string in the other byte order, so only the as-decoded order applies.
  if (buf.length >= 2 && buf.length % 2 === 0) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    views.push(swapped.toString("utf16le"));
  }
  return views;
}

function base64TextViews(run: string): string[] {
  return bufferTextViews(decodeBase64Buffer(run));
}

// Decode a hex run to its raw bytes. Returns the Buffer so callers can take
// MULTIPLE text interpretations (latin1 + both-endian utf16le) — `hex(utf16le(
// key))` is NUL-interleaved in the latin1 view and only contiguous in a utf16le
// view, exactly the base64 case. Returns null when the run isn't clean hex.
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

function hexTextViews(run: string): string[] {
  return bufferTextViews(decodeHexBuffer(run));
}

function decodeHex(run: string): string | null {
  const buf = decodeHexBuffer(run);
  return buf === null ? null : buf.toString("latin1");
}

// Percent decode WITH a decoded-index → run-index map (map[i] = run offset the
// i-th decoded char came from; map[text.length] = run.length). The map lets
// attributedSpan blame the encoded bytes that carried a credential instead of
// the whole run — PERCENT_RUN_RE's `[^\s%]` alternative makes a "run" any
// whitespace-free stretch, i.e. a whole minified document. Decodes atom-by-atom
// (a maximal %XX chain at once so multi-byte UTF-8 folds to one char).
//
// ATTRIBUTION ONLY, deliberately NOT the peel's decoder: this is a per-char JS
// loop where decodePercent is one native call, and the peel runs on every
// percent run of every scan — putting it there cost 3.6% repo-wide for no
// detection benefit. It runs only for a run that ALREADY tripped a pattern. It
// is also more lenient than decodeURIComponent (a malformed escape loses its own
// atom, not the whole run), so the two can disagree; when they do offendingRegion
// finds nothing and attributedSpan falls back to the whole run — prior behavior.
export function percentDecodeWithMap(run: string): { text: string; map: number[] } | null {
  if (!run.includes("%")) return null;
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < run.length; ) {
    let j = i;
    while (run[j] === "%" && /^[0-9a-fA-F]{2}$/.test(run.slice(j + 1, j + 3))) j += 3;
    if (j === i) {
      map.push(i);
      text += run[i];
      i += 1;
      continue;
    }
    let piece: string;
    try { piece = decodeURIComponent(run.slice(i, j)); } catch { piece = run.slice(i, j); }
    for (let k = 0; k < piece.length; k++) map.push(i);
    text += piece;
    i = j;
  }
  map.push(run.length);
  return text === run ? null : { text, map };
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

export interface EncodedScheme {
  re: RegExp;
  decode: (run: string) => string | null;
  label: string;
}

// All decoded text interpretations of a run for one scheme. base64 AND hex are
// byte-bearing, so each yields latin1 + both-endian utf16le views (a key carried
// as base64/hex of UTF-16LE is contiguous only in a utf16le view); percent has a
// single textual decoding.
export function runDecodeViews(scheme: EncodedScheme, run: string): string[] {
  if (scheme.label === "base64") return base64TextViews(run);
  if (scheme.label === "hex") return hexTextViews(run);
  const decoded = scheme.decode(run);
  return decoded === null ? [] : [decoded];
}

export const ENCODED_SCHEMES: EncodedScheme[] = [
  { re: BASE64_RUN_RE, decode: decodeBase64, label: "base64" },
  { re: HEX_RUN_RE, decode: decodeHex, label: "hex" },
  { re: PERCENT_RUN_RE, decode: decodePercent, label: "percent" },
];
