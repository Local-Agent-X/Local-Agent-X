/**
 * Bounded repair of almost-JSON from a model.
 *
 * Local models emit JSON that is one character wrong: a raw newline inside a
 * string, a trailing comma, a smart quote, `True`/`None` from Python. muse's
 * spec-audit replies failed at character ~101 on both attempts, so the gate
 * produced no verdict (2026-09-17). Each rule is shape-only — it never invents
 * a field or changes a value the parser could already read. Applied only after
 * a plain parse fails; the caller still validates against its schema.
 */

/** Escape raw control characters that appear INSIDE a JSON string literal. */
function escapeControlsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch === "\n") { out += "\\n"; continue; }
    if (inString && ch === "\r") { out += "\\r"; continue; }
    if (inString && ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out;
}

const SMART_QUOTES = /[“”]/g;
const TRAILING_COMMA = /,(\s*[}\]])/g;
/** Python literals a model reaches for when it forgets the format. */
const PY_LITERALS = /\b(True|False|None)\b(?=\s*[,}\]])/g;
const PY_MAP: Record<string, string> = { True: "true", False: "false", None: "null" };

/**
 * The text with the repairs applied, or null when nothing changed (so the
 * caller does not re-parse the same string).
 */
export function repairJsonText(raw: string): string | null {
  const repaired = escapeControlsInStrings(raw)
    .replace(SMART_QUOTES, '"')
    .replace(TRAILING_COMMA, "$1")
    .replace(PY_LITERALS, (m) => PY_MAP[m]);
  return repaired === raw ? null : repaired;
}
