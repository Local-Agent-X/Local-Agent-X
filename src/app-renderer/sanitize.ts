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
 * Decode the HTML entities `escapeHtml` produces, plus a few common extras.
 * `&amp;` is decoded LAST: decoding it first turns `&amp;lt;` into `&lt;` and
 * then `<`, a double-decode that re-introduces markup (the bug CodeQL flags as
 * double-escaping). Ordering ampersand last makes the round-trip lossless.
 */
const HTML_ENTITY_DECODES: [RegExp, string][] = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#x27;/g, "'"],
  [/&#39;/g, "'"],
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
];
export function decodeHtmlEntities(s: string): string {
  let out = s;
  for (const [re, ch] of HTML_ENTITY_DECODES) out = out.replace(re, ch);
  return out;
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
