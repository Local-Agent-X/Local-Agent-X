import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  AssociativeStore,
  LAX_DIR,
  MAX_ASSOCIATIONS,
  MAX_NODES,
  STORE_FILE,
} from "./types.js";

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

export function loadStore(): AssociativeStore {
  if (!existsSync(STORE_FILE)) return { nodes: [], associations: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      associations: Array.isArray(parsed.associations) ? parsed.associations : [],
    };
  } catch {
    return { nodes: [], associations: [] };
  }
}

export function saveStore(store: AssociativeStore): void {
  ensureDir();
  if (store.nodes.length > MAX_NODES) {
    store.nodes = store.nodes.slice(-MAX_NODES);
  }
  if (store.associations.length > MAX_ASSOCIATIONS) {
    store.associations = store.associations.slice(-MAX_ASSOCIATIONS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}
