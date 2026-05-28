import {
  extractEntities,
  extractRelationships,
  isContentWord,
  splitSentences,
} from "./text-utils.js";

export function toSummary(content: string): string {
  const sentences = splitSentences(content);
  if (sentences.length === 0) return content;

  const scored = sentences.map((s) => {
    const words = s.split(/\s+/);
    const contentWords = words.filter(isContentWord);
    const density = words.length > 0 ? contentWords.length / words.length : 0;
    const hasEntity = /@[\w-]+/.test(s) || /[A-Z][a-z]{2,}/.test(s);
    const hasNumber = /\d+/.test(s);
    const score = density + (hasEntity ? 0.2 : 0) + (hasNumber ? 0.1 : 0);
    return { sentence: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const keepCount = Math.max(1, Math.ceil(sentences.length * 0.3));
  const kept = scored.slice(0, keepCount).map((s) => s.sentence);

  const original = sentences.filter((s) => kept.includes(s));
  return original.join(" ");
}

export function toKeypoints(content: string): string {
  const sentences = splitSentences(content);
  if (sentences.length === 0) return content;

  const points: string[] = [];
  for (const s of sentences) {
    const contentWords = s
      .split(/\s+/)
      .filter(isContentWord);
    if (contentWords.length < 2) continue;

    const compressed = contentWords.slice(0, 8).join(" ");
    if (compressed.length > 5) {
      points.push(`- ${compressed}`);
    }
  }

  const unique: string[] = [];
  for (const p of points) {
    const isDupe = unique.some((u) => {
      const uWords = new Set(u.toLowerCase().split(/\s+/));
      const pWords = p.toLowerCase().split(/\s+/);
      let overlap = 0;
      for (const w of pWords) {
        if (uWords.has(w)) overlap++;
      }
      return overlap / pWords.length > 0.7;
    });
    if (!isDupe) unique.push(p);
  }

  const keepCount = Math.max(1, Math.ceil(sentences.length * 0.1));
  return unique.slice(0, keepCount).join("\n");
}

export function toSkeleton(content: string): string {
  const entities = extractEntities(content);
  const relationships = extractRelationships(content);

  const lines: string[] = [];

  if (entities.length > 0) {
    lines.push("Entities: " + entities.join(", "));
  }

  if (relationships.length > 0) {
    lines.push("Relations:");
    for (const rel of relationships.slice(0, 10)) {
      lines.push(`  ${rel}`);
    }
  }

  if (lines.length === 0) {
    const words = content.split(/\s+/).filter(isContentWord);
    const topWords = [...new Set(words)].slice(0, 10);
    lines.push("Keywords: " + topWords.join(", "));
  }

  return lines.join("\n");
}
