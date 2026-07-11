import { join } from "node:path";

import type { PatternsFile } from "./types.js";
import { getLaxDir } from "../../../lax-data-dir.js";
import { runMemoryGate } from "../../write-safely.js";
import type { MemoryPromotionContext } from "../../promotion-gate.js";
import { atomicWriteFileSync, createJsonStore, ensureDirFor } from "../../../util/json-store.js";

const PATTERNS_FILE = join(getLaxDir(), "proactive-patterns.json");
const MAX_INTERACTIONS = 2000;
const MAX_PATTERNS = 500;

const store = createJsonStore<PatternsFile>(PATTERNS_FILE, {
  defaults: () => ({ patterns: [], interactions: [], topicIndex: {} }),
});

export function loadPatterns(): PatternsFile {
  return store.load();
}

export function savePatterns(data: PatternsFile, promotion?: MemoryPromotionContext): void {
  ensureDirFor(PATTERNS_FILE);
  if (data.interactions.length > MAX_INTERACTIONS) {
    data.interactions = data.interactions.slice(-MAX_INTERACTIONS);
  }
  if (data.patterns.length > MAX_PATTERNS) {
    // Keep patterns with highest confidence
    data.patterns.sort((a, b) => b.confidence - a.confidence);
    data.patterns = data.patterns.slice(0, MAX_PATTERNS);
  }
  // The payload must pass the memory promotion gate before hitting disk, so
  // this writes via the atomic primitive rather than store.save() (which
  // stringifies internally and would bypass the gate).
  const serialized = JSON.stringify(data, null, 2);
  const gated = runMemoryGate({
    content: serialized,
    source: "tool",
    target: PATTERNS_FILE,
    promotion,
  });
  atomicWriteFileSync(PATTERNS_FILE, gated);
}
