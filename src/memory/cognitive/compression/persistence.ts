import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { COMPRESSED_DIR } from "./constants.js";
import { getLaxDir } from "../../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../../util/json-store.js";
import type { StoredCompression } from "./types.js";
import { runMemoryGate } from "../../write-safely.js";
import { createInternalMemoryContext } from "../../promotion-gate.js";

export function ensureDirs(): void {
  for (const dir of [getLaxDir(), COMPRESSED_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function storedPath(id: string): string {
  return join(COMPRESSED_DIR, `${id}.json`);
}

/** A stored compression by id; null when there is none or its file cannot be read. */
export function loadStored(id: string): StoredCompression | null {
  const filePath = storedPath(id);
  return existsSync(filePath) ? readStoredFile(filePath) : null;
}

export function writeStored(stored: StoredCompression): void {
  const target = storedPath(stored.id);
  const gated = runMemoryGate({
    content: JSON.stringify(stored, null, 2),
    source: "tool",
    target,
    promotion: { origin: "unknown", source: "session-compression" },
  });
  atomicWriteFileSync(target, gated);
}

export function writeStoredAtPath(filePath: string, stored: StoredCompression): void {
  const content = JSON.stringify(stored, null, 2);
  const gated = runMemoryGate({
    content,
    source: "tool",
    target: filePath,
    promotion: createInternalMemoryContext(content, filePath, "compression-rewrite"),
  });
  atomicWriteFileSync(filePath, gated);
}

export function listStoredFiles(): string[] {
  if (!existsSync(COMPRESSED_DIR)) return [];
  return readdirSync(COMPRESSED_DIR).filter((f) => f.endsWith(".json"));
}

export function readStoredFile(filePath: string): StoredCompression | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as StoredCompression;
  } catch {
    return null;
  }
}
