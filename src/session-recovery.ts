import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CHECKPOINT_DIR = join(homedir(), ".lax", "checkpoints");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  if (!existsSync(CHECKPOINT_DIR)) {
    mkdirSync(CHECKPOINT_DIR, { recursive: true, mode: 0o700 });
  }
}

function checkpointPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(CHECKPOINT_DIR, `${safe}.json`);
}

export function saveCheckpoint(sessionId: string, state: unknown): void {
  ensureDir();
  const data = {
    sessionId,
    savedAt: Date.now(),
    state,
  };
  writeFileSync(checkpointPath(sessionId), JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  cleanupOld();
}

export function loadCheckpoint(sessionId: string): unknown | null {
  const fp = checkpointPath(sessionId);
  if (!existsSync(fp)) return null;
  try {
    const raw = JSON.parse(readFileSync(fp, "utf-8"));
    return raw.state ?? null;
  } catch {
    return null;
  }
}

export function hasCheckpoint(sessionId: string): boolean {
  return existsSync(checkpointPath(sessionId));
}

export function clearCheckpoint(sessionId: string): void {
  const fp = checkpointPath(sessionId);
  if (existsSync(fp)) {
    unlinkSync(fp);
  }
}

function cleanupOld(): void {
  ensureDir();
  const now = Date.now();
  let files: string[];
  try {
    files = readdirSync(CHECKPOINT_DIR);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fp = join(CHECKPOINT_DIR, file);
    try {
      const st = statSync(fp);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        unlinkSync(fp);
      }
    } catch {
      // skip files we can't stat
    }
  }
}
