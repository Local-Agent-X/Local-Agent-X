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

/** Strip dangerous HTML tags from custom component content */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<link\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*\/?>/gi, "")
    .replace(/\bon\w+\s*=/gi, "data-blocked-handler=");
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
