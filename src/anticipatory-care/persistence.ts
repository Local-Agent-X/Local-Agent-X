import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { EventStore } from "./types.js";

const LAX_DIR = join(homedir(), ".lax");
const STORE_FILE = join(LAX_DIR, "upcoming-events.json");
const MAX_EVENTS = 500;
export const DAY_MS = 24 * 60 * 60 * 1000;

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

export function loadStore(): EventStore {
  if (!existsSync(STORE_FILE)) return { events: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

export function saveStore(store: EventStore): void {
  ensureDir();
  if (store.events.length > MAX_EVENTS) {
    store.events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    store.events = store.events.slice(0, MAX_EVENTS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

export function generateId(): string {
  return randomBytes(8).toString("hex");
}

export function parseDate(dateStr: string): number {
  return new Date(dateStr).getTime();
}
