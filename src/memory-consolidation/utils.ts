// Tiny shared helpers. ensureDirs guarantees the on-disk layout exists
// before any reader/writer runs; slugify and todayDateStr are formatting
// primitives shared by entity-page writers and the consolidation log.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tokenizeBasic, jaccardSimilarity as jaccardSim } from "../memory/text-utils.js";
import { LAX_DIR, MEMORY_DIR, ENTITIES_DIR } from "./types.js";

export function ensureDirs(): void {
  for (const dir of [LAX_DIR, MEMORY_DIR, join(MEMORY_DIR, "bank"), ENTITIES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function todayDateStr(): string {
  return new Date().toISOString().split("T")[0];
}

export function jaccardSimilarity(a: string, b: string): number {
  return jaccardSim(tokenizeBasic(a), tokenizeBasic(b));
}
