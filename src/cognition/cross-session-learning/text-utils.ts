import { STOP_WORDS } from "./types.js";

export function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function extractKeywords(text: string): string[] {
  return Array.from(wordSet(text));
}

export function normalizeDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

export function fuzzyMatch(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function clusterBySimilarity(
  items: string[],
  threshold: number
): { representative: string; items: string[] }[] {
  const clusters: { representative: string; items: string[] }[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [items[i]];
    assigned.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;
      if (fuzzyMatch(items[i], items[j]) >= threshold) {
        cluster.push(items[j]);
        assigned.add(j);
      }
    }

    clusters.push({ representative: items[i], items: cluster });
  }

  return clusters;
}
