// Tiny shared utilities. extractText probes the common content shapes
// (string, {text}) for canonical messages; parseArgs is the tool-args
// JSON guard; byteLengthUtf8 sizes the provider_state envelope without
// allocating an encoded buffer.

export function extractText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && "text" in (c as Record<string, unknown>)) {
    const v = (c as { text?: unknown }).text;
    return typeof v === "string" ? v : "";
  }
  return "";
}

export function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export function byteLengthUtf8(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}
