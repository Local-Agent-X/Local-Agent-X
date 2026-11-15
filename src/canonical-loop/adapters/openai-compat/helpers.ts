// Tiny shared utilities. extractText probes the common content shapes
// (string, {text}) for canonical messages. The tool-args JSON guard every
// adapter uses is parseArgs in ../tool-call-text-repair.ts.

export function extractText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && "text" in (c as Record<string, unknown>)) {
    const v = (c as { text?: unknown }).text;
    return typeof v === "string" ? v : "";
  }
  return "";
}
