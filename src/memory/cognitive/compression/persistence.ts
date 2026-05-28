import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { COMPRESSED_DIR, LAX_DIR } from "./constants.js";
import type { StoredCompression } from "./types.js";

export function ensureDirs(): void {
  for (const dir of [LAX_DIR, COMPRESSED_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function storedPath(id: string): string {
  return join(COMPRESSED_DIR, `${id}.json`);
}

export function loadStored(id: string): StoredCompression | null {
  const filePath = storedPath(id);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8")) as StoredCompression;
}

export function writeStored(stored: StoredCompression): void {
  writeFileSync(
    storedPath(stored.id),
    JSON.stringify(stored, null, 2),
    "utf-8",
  );
}

export function writeStoredAtPath(filePath: string, stored: StoredCompression): void {
  writeFileSync(filePath, JSON.stringify(stored, null, 2), "utf-8");
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
