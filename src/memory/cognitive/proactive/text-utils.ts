import { contentWords } from "../../text-utils.js";

/** A message's topics: its content words, then each pair of neighbours. */
export function extractTopics(text: string): string[] {
  const words = contentWords(text);

  const seen = new Set<string>();
  const topics: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      topics.push(w);
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + " " + words[i + 1];
    if (!seen.has(bigram)) {
      seen.add(bigram);
      topics.push(bigram);
    }
  }

  return topics.slice(0, 10); // cap at 10 topics per message
}
