import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import type { MemoryEntry, ScoresData } from "./types.js";
import {
  ARCHIVE_DIR,
  LAX_DIR,
  MEMORY_DIR,
  SCORES_FILE,
} from "./constants.js";

export function ensureDirs(): void {
  for (const dir of [LAX_DIR, MEMORY_DIR, ARCHIVE_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function loadScores(): ScoresData {
  try {
    if (existsSync(SCORES_FILE)) {
      const raw = readFileSync(SCORES_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // corrupted file — start fresh
  }
  return { records: {}, lastDecayRun: Date.now() };
}

export function persistScores(scores: ScoresData): void {
  try {
    const tmp = SCORES_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(scores, null, 2), "utf-8");
    renameSync(tmp, SCORES_FILE);
  } catch {
    try { writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2), "utf-8"); } catch {}
  }
}

export function listMemoryFiles(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  try {
    return readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

export function fileToEntry(filename: string, scores: ScoresData): MemoryEntry | null {
  const filePath = join(MEMORY_DIR, filename);
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const rec = scores.records[filename];
    return {
      id: filename,
      content,
      createdAt: stat.birthtimeMs || stat.ctimeMs,
      lastAccessed: rec?.lastAccessed || stat.mtimeMs,
      accessCount: rec?.accessCount || 0,
      userFeedback: rec?.userFeedback || undefined,
    };
  } catch {
    return null;
  }
}

export function loadMemoryFiles(scores: ScoresData): MemoryEntry[] {
  const files = listMemoryFiles();
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    const entry = fileToEntry(f, scores);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function moveToArchive(filename: string, scores: ScoresData): void {
  const src = join(MEMORY_DIR, filename);
  const dst = join(ARCHIVE_DIR, filename);
  try {
    if (!existsSync(ARCHIVE_DIR)) {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    renameSync(src, dst);
    delete scores.records[filename];
    persistScores(scores);
  } catch {
    // silently skip if move fails
  }
}
