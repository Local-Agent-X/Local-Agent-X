/**
 * Split a long agent reply into chunks suitable for individual voice notes.
 *
 * Splits on paragraph boundaries first (`\n\n`), then on sentence boundaries
 * (`. ! ?`) when a paragraph is itself too long. Each chunk fits within
 * `maxLen` characters. Returns an array of chunks in order.
 *
 * Used by Telegram + WhatsApp dispatchReply to turn a long agent response
 * (e.g. "transcribe this report so I can listen") into a sequence of
 * voice notes the user receives in order, instead of the prior approach
 * of speaking only the first sentence and dumping the rest as text.
 */
export function splitForVoiceChunks(text: string, maxLen: number = 3000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  // Pass 1: paragraph split. Greedy-merge consecutive paragraphs while
  // they fit, flush a chunk when adding the next would exceed maxLen.
  const paragraphs = trimmed.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";
  for (const p of paragraphs) {
    // Paragraph itself too long → flush buffer, then sentence-split.
    if (p.length > maxLen) {
      if (buffer) { chunks.push(buffer); buffer = ""; }
      chunks.push(...splitSentences(p, maxLen));
      continue;
    }
    if (buffer && buffer.length + 2 + p.length > maxLen) {
      chunks.push(buffer);
      buffer = p;
    } else {
      buffer = buffer ? `${buffer}\n\n${p}` : p;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/** Sentence-level split for paragraphs longer than maxLen. */
function splitSentences(text: string, maxLen: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let buffer = "";
  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    if (sentence.length > maxLen) {
      // Pathological single sentence > maxLen — hard-cut at maxLen so we
      // still get audio. Better than dropping it entirely.
      if (buffer) { chunks.push(buffer); buffer = ""; }
      for (let i = 0; i < sentence.length; i += maxLen) {
        chunks.push(sentence.slice(i, i + maxLen));
      }
      continue;
    }
    if (buffer && buffer.length + 1 + sentence.length > maxLen) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
