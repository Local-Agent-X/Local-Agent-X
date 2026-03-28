import { readdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface MemoryEntry {
  filename: string;
  content: string;
  modifiedAt: number;
}

interface DuplicatePair {
  a: string;
  b: string;
  score: number;
}

const SIMILARITY_THRESHOLD = 0.7;

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

export function similarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function findDuplicates(memories: MemoryEntry[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const score = similarity(memories[i].content, memories[j].content);
      if (score >= SIMILARITY_THRESHOLD) {
        pairs.push({
          a: memories[i].filename,
          b: memories[j].filename,
          score,
        });
      }
    }
  }

  return pairs.sort((x, y) => y.score - x.score);
}

export function deduplicateMemories(
  memoryDir: string,
): { removed: string[]; merged: string[] } {
  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
  const memories: MemoryEntry[] = files.map((filename) => {
    const fullPath = join(memoryDir, filename);
    const stat = statSync(fullPath);
    return {
      filename,
      content: readFileSync(fullPath, "utf-8"),
      modifiedAt: stat.mtimeMs,
    };
  });

  const duplicates = findDuplicates(memories);
  const removed: string[] = [];
  const merged: string[] = [];
  const alreadyRemoved = new Set<string>();

  for (const pair of duplicates) {
    if (alreadyRemoved.has(pair.a) || alreadyRemoved.has(pair.b)) continue;

    const entryA = memories.find((m) => m.filename === pair.a)!;
    const entryB = memories.find((m) => m.filename === pair.b)!;

    // Keep the more recent or more detailed version
    let keeper: MemoryEntry;
    let discard: MemoryEntry;

    if (entryA.content.length !== entryB.content.length) {
      keeper = entryA.content.length >= entryB.content.length ? entryA : entryB;
      discard = keeper === entryA ? entryB : entryA;
    } else {
      keeper = entryA.modifiedAt >= entryB.modifiedAt ? entryA : entryB;
      discard = keeper === entryA ? entryB : entryA;
    }

    // If the discarded entry has unique content, append it to the keeper
    const keeperTokens = tokenize(keeper.content);
    const discardTokens = tokenize(discard.content);
    let hasUniqueContent = false;
    for (const token of discardTokens) {
      if (!keeperTokens.has(token)) {
        hasUniqueContent = true;
        break;
      }
    }

    if (hasUniqueContent && pair.score < 0.95) {
      const mergedContent = keeper.content.trimEnd() + "\n\n---\n\n" + discard.content;
      writeFileSync(join(memoryDir, keeper.filename), mergedContent, "utf-8");
      merged.push(keeper.filename);
    }

    unlinkSync(join(memoryDir, discard.filename));
    removed.push(discard.filename);
    alreadyRemoved.add(discard.filename);
  }

  return { removed, merged };
}
