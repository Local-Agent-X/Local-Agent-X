// Progressive-relaxation recovery for tool arguments emitted by weaker models.
// Two layers:
//   1. repairJson — tolerate common JSON malformations (trailing commas,
//      single-quoted strings/keys, unquoted keys, stray code fences) before
//      falling back to treating the arg blob as opaque.
//   2. coerceArgs — when a parsed value's type doesn't match the tool's
//      schema, try safe coercion (string "5" → 5, "true" → true, "[1,2]" → [1,2])
//      instead of rejecting outright.
//
// Both layers are silent: they repair in-place and return a list of applied
// fixes so the caller can log telemetry. No behavior change when inputs are
// already well-formed.

export interface JsonRepairResult {
  ok: true;
  value: Record<string, unknown>;
  fixes: string[];
}
export interface JsonRepairFailure {
  ok: false;
  fixes: string[];
}

export function repairJson(raw: string): JsonRepairResult | JsonRepairFailure {
  const fixes: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, fixes };

  // Fast path
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
  } catch {}

  let s = trimmed;

  // Strip markdown code fences (```json ... ```)
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    fixes.push("stripped-code-fence");
  }

  // If the whole thing is wrapped in one set of matched brackets but has
  // trailing garbage after, slice to the last closing brace.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 || (lastBrace > 0 && lastBrace < s.length - 1)) {
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      s = s.slice(firstBrace, lastBrace + 1);
      fixes.push("trimmed-to-braces");
    }
  }

  // Try parse after fence/brace trim
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
  } catch {}

  // Remove trailing commas before } or ]
  const noTrailingCommas = s.replace(/,(\s*[}\]])/g, "$1");
  if (noTrailingCommas !== s) {
    s = noTrailingCommas;
    fixes.push("removed-trailing-comma");
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
    } catch {}
  }

  // Convert single-quoted strings to double-quoted. Cautious regex: only flips
  // tokens that look like 'key' or 'value' — bare single-quote pairs. Skips
  // apostrophes inside double-quoted strings by processing char-by-char.
  const singleToDouble = convertSingleQuotedStrings(s);
  if (singleToDouble !== s) {
    s = singleToDouble;
    fixes.push("single-to-double-quotes");
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
    } catch {}
  }

  // Quote bare identifier keys: { foo: 1 } → { "foo": 1 }
  const quotedKeys = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  if (quotedKeys !== s) {
    s = quotedKeys;
    fixes.push("quoted-bare-keys");
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
    } catch {}
  }

  // Python-ish literals
  const pyLiterals = s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  if (pyLiterals !== s) {
    s = pyLiterals;
    fixes.push("normalized-py-literals");
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, fixes };
    } catch {}
  }

  return { ok: false, fixes };
}

function convertSingleQuotedStrings(src: string): string {
  let out = "";
  let i = 0;
  let inDouble = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      out += c + src[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      out += c;
      i++;
      continue;
    }
    if (c === "'" && !inDouble) {
      // Read until the next unescaped single quote
      let j = i + 1;
      let body = "";
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < src.length) {
          body += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '"') body += '\\"';
        else body += src[j];
        j++;
      }
      if (j < src.length) {
        out += `"${body}"`;
        i = j + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

interface PropSchema {
  type?: string;
  enum?: unknown[];
}
interface ToolSchema {
  type?: string;
  properties?: Record<string, PropSchema>;
  required?: string[];
}

export interface CoerceResult {
  coerced: Record<string, unknown>;
  fixes: string[];
}

export function coerceArgs(args: Record<string, unknown>, schema: ToolSchema | undefined): CoerceResult {
  const fixes: string[] = [];
  if (!schema || !schema.properties) return { coerced: args, fixes };
  const out: Record<string, unknown> = { ...args };
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in out)) continue;
    const val = out[key];
    const want = propSchema.type;
    if (!want) continue;

    if (want === "number" && typeof val === "string") {
      const trimmed = val.trim();
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        out[key] = Number(trimmed);
        fixes.push(`${key}:string→number`);
        continue;
      }
    }
    if (want === "integer" && typeof val === "string") {
      const trimmed = val.trim();
      if (/^-?\d+$/.test(trimmed)) {
        out[key] = parseInt(trimmed, 10);
        fixes.push(`${key}:string→integer`);
        continue;
      }
    }
    if (want === "boolean" && typeof val === "string") {
      const lower = val.trim().toLowerCase();
      if (lower === "true") { out[key] = true; fixes.push(`${key}:string→bool`); continue; }
      if (lower === "false") { out[key] = false; fixes.push(`${key}:string→bool`); continue; }
    }
    if (want === "boolean" && typeof val === "number") {
      if (val === 0) { out[key] = false; fixes.push(`${key}:number→bool`); continue; }
      if (val === 1) { out[key] = true; fixes.push(`${key}:number→bool`); continue; }
    }
    if (want === "string" && typeof val === "number") {
      out[key] = String(val);
      fixes.push(`${key}:number→string`);
      continue;
    }
    if (want === "string" && typeof val === "boolean") {
      out[key] = val ? "true" : "false";
      fixes.push(`${key}:bool→string`);
      continue;
    }
    if (want === "array" && typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            out[key] = parsed;
            fixes.push(`${key}:string→array`);
            continue;
          }
        } catch {}
      }
      // Single-element array from scalar string
      out[key] = [val];
      fixes.push(`${key}:string→array[1]`);
      continue;
    }
  }
  return { coerced: out, fixes };
}
