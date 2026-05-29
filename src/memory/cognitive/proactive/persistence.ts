import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { PatternsFile } from "./types.js";
import { getLaxDir } from "../../../lax-data-dir.js";
import { runMemoryGate } from "../../write-safely.js";

const LAX_DIR = getLaxDir();
const PATTERNS_FILE = join(LAX_DIR, "proactive-patterns.json");
const MAX_INTERACTIONS = 2000;
const MAX_PATTERNS = 500;

function ensureDir(): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function loadPatterns(): PatternsFile {
  try {
    if (existsSync(PATTERNS_FILE)) {
      const raw = readFileSync(PATTERNS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.patterns)) return parsed as PatternsFile;
    }
  } catch {}
  return { patterns: [], interactions: [], topicIndex: {} };
}

export function savePatterns(data: PatternsFile): void {
  ensureDir();
  if (data.interactions.length > MAX_INTERACTIONS) {
    data.interactions = data.interactions.slice(-MAX_INTERACTIONS);
  }
  if (data.patterns.length > MAX_PATTERNS) {
    // Keep patterns with highest confidence
    data.patterns.sort((a, b) => b.confidence - a.confidence);
    data.patterns = data.patterns.slice(0, MAX_PATTERNS);
  }
  const serialized = JSON.stringify(data, null, 2);
  const gated = runMemoryGate({
    content: serialized,
    source: "tool",
    target: PATTERNS_FILE,
  });
  atomicWrite(PATTERNS_FILE, gated);
}
