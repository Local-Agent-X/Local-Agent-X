/**
 * Persistent, self-healing model-capability registry.
 *
 * The runtime already LEARNS each model's quirks — openai-http catches a 400
 * ("does not support tools" / "does not support reasoning_effort") and
 * remembers it; openai-compat latches a local model that silent-fails on
 * tools. Before this store those facts lived in in-memory Sets and evaporated
 * on every restart, so the same failed round-trip was re-paid on every cold
 * start. This persists them.
 *
 * Two layers, merged on read:
 *   - SEED (model-capabilities-seed.ts): public facts bundled with the app.
 *     Authoritative and updatable — never written to disk.
 *   - LEARNED (~/.lax/model-capabilities.json): facts discovered at runtime on
 *     THIS machine. Self-healing: an observation writes through here. Delete
 *     the file to force a clean rebuild from seed + relearning.
 *
 * Keyed by (baseURL, model), NOT (provider, model): the same model name behind
 * different endpoints has different capabilities — qwen2:7b on local Ollama
 * can't do tools, qwen2:7b on Ollama Turbo can. Keying by model alone once let
 * a "no tools" finding from one endpoint poison every other (AUDIT Critical #4).
 *
 * No network, no telemetry — everything stays on the user's disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { MODEL_CAPABILITY_SEED, type ModelCapabilitySeedEntry } from "./model-capabilities-seed.js";

const logger = createLogger("providers.model-capabilities");

interface CapabilityEntry {
  noTools?: boolean;
  unsupportedParams?: string[];
}

interface StoreShape {
  version: number;
  entries: Record<string, CapabilityEntry>;
}

const STORE_VERSION = 1;

function storeKey(baseURL: string | undefined, model: string): string {
  return `${baseURL ?? ""}::${model}`;
}

/** Seed entries indexed by (baseURL, model). Built once; read-only. */
const SEED: ReadonlyMap<string, CapabilityEntry> = (() => {
  const m = new Map<string, CapabilityEntry>();
  for (const e of MODEL_CAPABILITY_SEED as ModelCapabilitySeedEntry[]) {
    m.set(storeKey(e.baseURL, e.model), {
      ...(e.noTools ? { noTools: true } : {}),
      ...(e.unsupportedParams ? { unsupportedParams: [...e.unsupportedParams] } : {}),
    });
  }
  return m;
})();

/** Runtime-learned layer, loaded lazily from disk. null = not yet loaded. */
let learned: Map<string, CapabilityEntry> | null = null;

function storeFile(): string {
  return join(getLaxDir(), "model-capabilities.json");
}

function ensureLoaded(): Map<string, CapabilityEntry> {
  if (learned) return learned;
  const next = new Map<string, CapabilityEntry>();
  const file = storeFile();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<StoreShape>;
      const entries = parsed?.entries;
      if (entries && typeof entries === "object") {
        for (const [k, v] of Object.entries(entries)) {
          if (!v || typeof v !== "object") continue;
          const entry: CapabilityEntry = {};
          if (v.noTools === true) entry.noTools = true;
          if (Array.isArray(v.unsupportedParams)) {
            entry.unsupportedParams = v.unsupportedParams.filter((p): p is string => typeof p === "string");
          }
          next.set(k, entry);
        }
      }
    } catch {
      // Corrupt file → start from an empty learned layer; seed still applies.
      // A capability cache must never fail a chat turn over a bad JSON blob.
    }
  }
  learned = next;
  return learned;
}

function persist(): void {
  const map = learned;
  if (!map) return;
  const shape: StoreShape = { version: STORE_VERSION, entries: Object.fromEntries(map) };
  const dir = getLaxDir();
  const file = storeFile();
  const tmp = file + ".tmp." + randomBytes(4).toString("hex");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(shape, null, 2), "utf-8");
    renameSync(tmp, file);
  } catch (e) {
    // The in-memory layer stays authoritative for this session; a failed
    // write just means we relearn after restart. Don't crash a live turn.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    logger.warn(`failed to persist model capabilities: ${(e as Error).message}`);
  }
}

/** True if (baseURL, model) is known to reject the `tools` field. */
export function hasNoTools(baseURL: string | undefined, model: string): boolean {
  const key = storeKey(baseURL, model);
  return SEED.get(key)?.noTools === true || ensureLoaded().get(key)?.noTools === true;
}

/** Record that (baseURL, model) rejects tools. Persists through to disk. */
export function recordNoTools(baseURL: string | undefined, model: string): void {
  const key = storeKey(baseURL, model);
  const map = ensureLoaded();
  const entry = map.get(key) ?? {};
  if (entry.noTools) return; // already known — no redundant write
  entry.noTools = true;
  map.set(key, entry);
  persist();
}

/** True if (baseURL, model) hard-400s on `param` (seed or learned). */
export function hasUnsupportedParam(baseURL: string | undefined, model: string, param: string): boolean {
  const key = storeKey(baseURL, model);
  return (
    SEED.get(key)?.unsupportedParams?.includes(param) === true ||
    ensureLoaded().get(key)?.unsupportedParams?.includes(param) === true
  );
}

/** Record that (baseURL, model) rejects `param`. Persists through to disk. */
export function recordUnsupportedParam(baseURL: string | undefined, model: string, param: string): void {
  const key = storeKey(baseURL, model);
  const map = ensureLoaded();
  const entry = map.get(key) ?? {};
  const params = entry.unsupportedParams ?? [];
  if (params.includes(param)) return; // already known — no redundant write
  entry.unsupportedParams = [...params, param];
  map.set(key, entry);
  persist();
}

/**
 * Test-only: drop the in-memory learned layer so the next access reloads from
 * disk (or, with LAX_DATA_DIR pointed at a fresh temp dir, from seed alone).
 */
export function _resetForTests(): void {
  learned = null;
}

/**
 * Test-only: full test isolation — wipe disk + memory, unlike
 * `_resetForTests()` which drops memory only to simulate a restart (and so
 * reloads the same facts back off disk). Unlinks the store file (tolerating
 * a missing file — never throws) and clears the in-memory learned layer, so
 * the next access rebuilds from seed alone.
 */
export function _wipeForTests(): void {
  try {
    unlinkSync(storeFile());
  } catch {
    // ENOENT / already-absent → nothing to wipe. A test-isolation helper
    // must never throw over a store file that was never written.
  }
  learned = null;
}
