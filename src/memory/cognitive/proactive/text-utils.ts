const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their", "this",
  "that", "these", "those", "what", "which", "who", "whom", "whose",
  "and", "but", "or", "nor", "not", "so", "yet", "for", "to", "of",
  "in", "on", "at", "by", "with", "from", "up", "about", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "just", "also", "very", "too", "quite", "really", "then", "than",
  "when", "where", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "any", "many",
  "much", "own", "same", "here", "there", "now", "only", "even",
  "still", "already", "don't", "doesn't", "didn't", "won't",
  "can't", "couldn't", "shouldn't", "wouldn't", "let", "get",
  "got", "going", "want", "like", "know", "think", "make",
  "sure", "yeah", "yes", "okay", "ok", "hey", "hi", "hello",
  "please", "thanks", "thank", "well", "right",
]);

/** Simple topic extraction from a message based on word frequency and n-grams. */
export function extractTopics(text: string): string[] {
  const lower = text.toLowerCase();

  const words = lower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

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
