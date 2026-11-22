// Tiny shared helpers. ensureDirs guarantees the on-disk layout exists
// before any reader/writer runs; todayDateStr is a formatting primitive
// shared by the fact readers and the consolidation log. Entity slugs come
// from memory/utils.ts slugify, the one the entity pages are named by.

import { existsSync, mkdirSync } from "node:fs";
import { tokenizeBasic, jaccardSimilarity } from "../../text-utils.js";
import { MEMORY_DIR } from "./types.js";
import { getLaxDir } from "../../../lax-data-dir.js";

export function ensureDirs(): void {
  for (const dir of [getLaxDir(), MEMORY_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function todayDateStr(): string {
  return new Date().toISOString().split("T")[0];
}

/** Word overlap of two texts: the shared Jaccard over tokenizeBasic's words. */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeBasic(a), tokenizeBasic(b));
}
