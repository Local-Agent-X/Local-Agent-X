/** Convert a phone string to a WhatsApp JID. Pass-through if already a JID. */
export function toJid(phone: string): string {
  const clean = phone.replace(/\D/g, "");
  return clean.includes("@") ? clean : `${clean}@s.whatsapp.net`;
}

/**
 * Split text into chunks of at most maxLen characters. Prefers to split on
 * the last newline within range, falling back to last space, falling back
 * to a hard cut. Trims leading whitespace on continuations.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
