export function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

export function redirectMessage(requested: string, landed: string): string {
  if (!requested || !landed) return "";
  if (requested === landed) return "";
  // Strip the leading "www." — most sites www-canonicalize.
  const norm = (h: string) => h.replace(/^www\./, "");
  if (norm(requested) === norm(landed)) return "";
  return `\n⚠ REDIRECTED: requested ${requested}, landed on ${landed}`;
}
