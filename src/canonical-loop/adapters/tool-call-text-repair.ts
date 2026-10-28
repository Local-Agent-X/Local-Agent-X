/**
 * Low-level machinery for the tool-call-from-text rescue path — leaf
 * module with no local imports so every consumer (the syntax scanners,
 * the extractor, every adapter's parseArgs) shares ONE implementation
 * without import cycles.
 *
 * Lives here:
 *   - scanBalancedObject / findJsonObjects: balanced-brace JSON scanning
 *     over free text, string-literal aware.
 *   - repairJsonText: bounded near-miss JSON repair, classified as
 *     cosmetic (complete-but-sloppy) vs structural (truncated — callers
 *     must never execute those).
 *   - parseArgs: the structured tool-call args guard every adapter
 *     (openai-compat, anthropic, gemini-native) reports calls through.
 *   - resolveToolName: candidate tool-name resolution against the offered
 *     tool set (normalization ladder + bounded edit distance).
 */

/** Candidate names longer than this are junk, never tool calls. */
export const MAX_TOOL_NAME_CHARS = 120;
/**
 * Args payload cap in UTF-16 code units. Every code unit encodes to at
 * least one UTF-8 byte, so anything over the cap here is over 256KB on
 * the wire too — the cap bounds pathological payloads; it is not exact
 * byte accounting.
 */
export const MAX_ARGS_CHARS = 256 * 1024;

export interface JsonObjectHit {
  start: number;
  end: number;
  parsed: Record<string, unknown>;
}

/**
 * Memo for scanBalancedObject over ONE string: `{` offset → exclusive end
 * (or -1). One scan from `p` visits every nested `{` outside string
 * literals in the same parse state a standalone scan from that offset
 * would start in, so their verdicts are recorded for free. Without it a
 * text full of openers that never balance (`[a]{` × 8000) rescans the
 * same unbalanced tail once per opener — quadratic, 30s on 32KB.
 */
export type BalancedScanMemo = Map<number, number>;

/**
 * Scan one balanced-brace JSON object starting at `start` (must sit on a
 * "{"), respecting string literals. Returns the exclusive end index, or
 * -1 if the braces never balance before the end of input. Pass one `memo`
 * per string to make repeat scans O(1): a failed scan records -1 for
 * every opener still on its stack, so a page of `{` that never closes is
 * walked ONCE, not once per opener. The scan itself is deliberately not
 * length-capped — a cap would stop before those verdicts were known and
 * hand the same tail to the next opener, quadratic again above the cap.
 * Over-cap payloads are rejected by the callers, which compare the
 * returned length against MAX_ARGS_CHARS.
 */
export function scanBalancedObject(s: string, start: number, memo?: BalancedScanMemo): number {
  const known = memo?.get(start);
  if (known !== undefined) return known;
  const open: number[] = [];
  let inString = false, escape = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") open.push(j);
    else if (ch === "}") {
      const at = open.pop();
      if (at !== undefined) memo?.set(at, j + 1);
      if (open.length === 0) return j + 1;
    }
  }
  // Every opener still open was met outside a string literal — the same
  // state a standalone scan from it starts in — so its verdict is final.
  for (const at of open) memo?.set(at, -1);
  return -1;
}

/**
 * Find balanced-brace JSON object substrings and JSON.parse each. Returns
 * the parse results with their string offsets so the caller can excise
 * consumed regions. Skips malformed JSON without throwing.
 */
export function findJsonObjects(s: string): JsonObjectHit[] {
  const hits: JsonObjectHit[] = [];
  const memo: BalancedScanMemo = new Map();
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") { i++; continue; }
    const end = scanBalancedObject(s, i, memo);
    if (end === -1) { i++; continue; }
    try {
      const parsed = JSON.parse(s.slice(i, end));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        hits.push({ start: i, end, parsed: parsed as Record<string, unknown> });
      }
    } catch { /* skip malformed */ }
    i = end;
  }
  return hits;
}

function parses(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

function trimDanglingComma(s: string): string {
  let e = s.length;
  while (e > 0 && " \t\r\n".includes(s[e - 1])) e--;
  return s[e - 1] === "," ? s.slice(0, e - 1) : s;
}

export type JsonRepairKind = "none" | "cosmetic" | "structural";

export interface RepairedJson {
  /** Repaired text — guaranteed to JSON.parse. */
  text: string;
  /**
   * How invasive the repair was.
   *  - "none": input already parsed; returned unchanged.
   *  - "cosmetic": dangling commas dropped and/or raw control chars
   *    escaped — the payload was structurally COMPLETE.
   *  - "structural": unbalanced braces/brackets or an unterminated string
   *    had to be CLOSED. Balanced output never needs structural
   *    completion, so a structural repair is definitionally a truncation
   *    artifact (stream cut, output-budget exhaustion). Callers must
   *    never execute a structurally-completed payload — a partial write
   *    or shell command is worse than no call at all.
   */
  kind: JsonRepairKind;
}

/**
 * Bounded repair ladder for near-miss JSON: strict parse → one cleaning
 * walk (drop trailing commas, escape raw control chars inside strings) →
 * close whatever the model left open (quote, then ≤ 50 brackets/braces)
 * → parse again. Returns text GUARANTEED to JSON.parse tagged with the
 * repair class, or null. Never invents data — it only removes dangling
 * commas, escapes control chars, and closes open structures; it does not
 * quote bare keys or guess values.
 */
export function repairJsonText(raw: string): RepairedJson | null {
  const s = raw.trim();
  if (!s) return null;
  if (parses(s)) return { text: s, kind: "none" };
  let out = "";
  const open: string[] = [];
  let inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { out += ch; escape = false; continue; }
      if (ch === "\\") { out += ch; escape = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        // Models paste real newlines/tabs into string values. Escape them.
        out += code === 10 ? "\\n" : code === 13 ? "\\r" : code === 9 ? "\\t"
          : "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "{" || ch === "[") { open.push(ch); out += ch; continue; }
    if (ch === "}" || ch === "]") {
      if (open[open.length - 1] === (ch === "}" ? "{" : "[")) open.pop();
      out = trimDanglingComma(out); // `,}` / `,]` is the classic near-miss
      out += ch;
      continue;
    }
    out += ch;
  }
  if (escape) out = out.slice(0, -1); // dangling backslash would escape our closing quote
  if (parses(out)) return { text: out, kind: "cosmetic" };
  if (open.length > 50) return null; // bounded — runaway nesting is garbage, not a near-miss
  let closed = out;
  if (inString) closed += '"';
  closed = trimDanglingComma(closed);
  for (let i = open.length - 1; i >= 0; i--) closed += open[i] === "{" ? "}" : "]";
  return parses(closed) ? { text: closed, kind: "structural" } : null;
}

/**
 * Tool-args JSON guard for a structured call's `arguments` string. Valid
 * JSON passes through untouched (whatever its type). On a parse failure,
 * run the bounded repair ladder in COSMETIC-only mode: trailing commas and
 * raw control chars are sloppiness in a complete payload and safe to fix,
 * but a payload that needs STRUCTURAL completion (unclosed
 * braces/brackets/strings) is a truncation artifact — finish_reason=length,
 * Anthropic max_tokens mid-input_json_delta, and kin — and stays `{_raw}`
 * so the failure is loud. Executing a structurally-completed payload would
 * run a PARTIAL write or command. Only an OBJECT result is trusted;
 * over-cap payloads skip the ladder entirely (the cap bounds pathology,
 * not normal args).
 *
 * Per provider: Anthropic's API streams tool_use input as input_json_delta
 * string fragments (complete JSON unless the stream was cut, which is
 * structural and stays `{_raw}`); its CLI path and Gemini's functionCall
 * `args` carry an object their transport JSON.stringifies, which always
 * parses. So the ladder only changes anything for a string the model
 * itself wrote sloppily — the OpenAI-compat local-model case.
 *
 * NOTE: the structured path has a second, independent repair point
 * downstream — tool-execution's resolve-tool.ts parseArgs delegates to
 * arg-repair.ts repairJson (single-quote/bare-key fixes, type coercion).
 * Two ladders, one seam family; unification is a parked follow-up.
 */
export function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* repair below */ }
  if (raw.length <= MAX_ARGS_CHARS) {
    const r = repairJsonText(raw);
    if (r !== null && r.kind !== "structural") {
      const v: unknown = JSON.parse(r.text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
  }
  return { _raw: raw };
}

/** Canonical comparison form: strips router prefixes (`functions.` /
 *  `tools.`), splits Camel humps, lowercases, folds `-`/space runs to `_`. */
function canonicalName(s: string): string {
  return s.trim()
    .replace(/^(functions|tools)[.:]/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

/** Two-row Levenshtein with an early bail once distance must exceed `cap`. */
function levenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Resolve a raw candidate name against the offered tool set. Ladder:
 * exact → case-fold → prefix strip → `-`/space→`_` → CamelCase→snake
 * (the last four folded into canonicalName) → bounded edit distance
 * (≤ 2 AND ≤ 30% of the offered name's length, unique best only).
 * Returns the offered name to call, or null — never a guess when two
 * offered tools tie.
 */
export function resolveToolName(raw: string, validToolNames: Set<string>): string | null {
  const name = raw.trim();
  if (!name || name.length > MAX_TOOL_NAME_CHARS) return null;
  if (validToolNames.has(name)) return name;
  const canon = canonicalName(name);
  if (!canon) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  let tie = false;
  for (const v of validToolNames) {
    const vc = canonicalName(v);
    if (vc === canon) return v;
    const cap = Math.min(2, Math.floor(vc.length * 0.3));
    if (cap === 0) continue;
    const d = levenshtein(canon, vc, cap);
    if (d > cap) continue;
    if (d < bestDist) { best = v; bestDist = d; tie = false; }
    else if (d === bestDist) tie = true;
  }
  return tie ? null : best;
}
