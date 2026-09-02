/**
 * Sanitization primitives — HTML escape, JS literal escape, tag stripping,
 * and safe display-string coercion for arbitrary user values.
 */

export function escapeHtml(s: unknown): string {
  if (typeof s !== "string") return String(s ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Allowlist sanitizer for custom-component HTML. Complete by construction:
 * everything is HTML-escaped first, so no tag, attribute, event handler, or
 * script can be live markup; THEN a fixed allowlist of attribute-free
 * formatting tags is re-permitted. A tag carrying any attribute
 * (`<b onclick=…>`) escapes to `&lt;b onclick=…&gt;`, which the re-permit
 * regex (tag name immediately followed by `&gt;`) cannot match, so it stays
 * inert text. This avoids the bypasses of the old blocklist regex
 * (`<scr<script>ipt>`, `on*=` obfuscation, `<svg>`, attribute tricks).
 */
const SAFE_TAGS =
  "b|i|em|strong|u|s|del|mark|small|sub|sup|code|pre|kbd|br|p|span|div|" +
  "ul|ol|li|h2|h3|h4|h5|h6|blockquote|hr|table|thead|tbody|tr|th|td";
const REPERMIT_RE = new RegExp(`&lt;(/?(?:${SAFE_TAGS}))&gt;`, "gi");

export function sanitizeHtml(html: string): string {
  return escapeHtml(html).replace(REPERMIT_RE, "<$1>");
}

/**
 * Decode the HTML entities `escapeHtml` produces, plus the named and numeric
 * forms (`&#8217;`, `&#x2019;`) common in model output and scraped HTML.
 * Decoding is a SINGLE combined pass: one regex consumes each entity exactly
 * once and replacement text is never rescanned, so `&amp;lt;` → `&lt;` and
 * `&amp;amp;` → `&amp;` — never a cascade to `<` or `&` (the double-decode
 * CodeQL flags as double-escaping). Unknown names and invalid numeric
 * references (lone surrogates, > U+10FFFF, control characters) stay literal.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["amp", "&"],
  ["nbsp", " "],
  ["rsquo", "\u2019"], ["lsquo", "\u2018"], ["rdquo", "\u201D"], ["ldquo", "\u201C"],
  ["mdash", "\u2014"], ["ndash", "\u2013"], ["hellip", "\u2026"],
  ["times", "\u00D7"], ["bull", "\u2022"], ["middot", "\u00B7"],
  ["copy", "\u00A9"], ["reg", "\u00AE"], ["trade", "\u2122"],
  ["deg", "\u00B0"], ["sect", "\u00A7"], ["para", "\u00B6"],
  ["plusmn", "\u00B1"], ["frac12", "\u00BD"], ["frac14", "\u00BC"], ["frac34", "\u00BE"],
  ["euro", "\u20AC"], ["pound", "\u00A3"], ["cent", "\u00A2"],
]);
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

/** A numeric character reference decodes only to a sane scalar value: no lone
 *  surrogates, nothing past U+10FFFF, no C0/C1 control characters (or DEL) —
 *  an invalid reference stays as the literal source text. */
function decodeNumericRef(literal: string, cp: number): string {
  if (!Number.isInteger(cp) || cp > 0x10ffff) return literal;
  if (cp >= 0xd800 && cp <= 0xdfff) return literal;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return literal;
  return String.fromCodePoint(cp);
}

export function decodeHtmlEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, hex?: string, dec?: string, name?: string) => {
    // Map lookup, not object indexing: `&constructor;` must stay literal.
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? m;
    return decodeNumericRef(m, parseInt((hex ?? dec)!, hex !== undefined ? 16 : 10));
  });
}

/** Reduce arbitrary HTML to plain text: strip tags (to fixpoint, so nested or
 * split tags can't survive) then decode entities. */
export function htmlToText(html: string): string {
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return decodeHtmlEntities(out).trim();
}

/** Escape a value for use in a JS string literal */
export function escapeJs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\//g, "<\\/");
}

/** Safely convert any value to a display string (handles objects, arrays, nulls) */
export function safeStr(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return val.map(safeStr).join(", ");
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const display = obj.label ?? obj.name ?? obj.title ?? obj.text ?? obj.value ?? obj.id ?? obj.key;
    if (display !== undefined && typeof display !== "object") return String(display);
    try { return JSON.stringify(val); } catch { return ""; }
  }
  return String(val);
}
