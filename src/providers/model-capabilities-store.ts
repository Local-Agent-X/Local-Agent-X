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

/** Result of a LIVE behavioral tool-call check (see tool-capability-probe). */
export interface ToolsVerified {
  ok: boolean;
  /** ISO timestamp of the observation. */
  at: string;
}

interface CapabilityEntry {
  noTools?: boolean;
  /** ISO timestamp of the LEARNED no-tools observation; absent on a seeded
   *  entry and on entries written before the latch had a TTL. */
  noToolsAt?: string;
  unsupportedParams?: string[];
  /**
   * Live-verified tool-calling: did a structured tool_call actually come back
   * from this (baseURL, model)? Vendor metadata lies both ways — a model can
   * advertise "tools" and still be terrible, or lack the flag and work.
   * LEARNED-only (an observation made on THIS machine — never seeded).
   */
  toolsVerified?: ToolsVerified;
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
          if (typeof v.noToolsAt === "string") entry.noToolsAt = v.noToolsAt;
          if (Array.isArray(v.unsupportedParams)) {
            entry.unsupportedParams = v.unsupportedParams.filter((p): p is string => typeof p === "string");
          }
          const tv = v.toolsVerified;
          if (tv && typeof tv === "object" && typeof tv.ok === "boolean" && typeof tv.at === "string") {
            entry.toolsVerified = { ok: tv.ok, at: tv.at };
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

/**
 * How long a LEARNED no-tools latch holds before tools are tried again. A
 * seeded latch is a public fact and never expires; a learned one is a single
 * observation on this machine, and the observation that sets it — an empty
 * reply with tools attached — is also what a capable model does once in a
 * while under sampling. Until 2026-09-23 that one empty was permanent AND
 * persisted: a 27B that had just made a native tool call answered one
 * `…tool, user, user` round with nothing, and the install lost native tools
 * for that model until someone edited this file (op-outcomes, EXP-12c).
 * With a TTL, a genuinely incapable model re-latches at the cost of one dead
 * first leg per window; a capable one gets its tools back by itself.
 */
export const NO_TOOLS_LATCH_TTL_MS = 60 * 60_000;

/** True if (baseURL, model) is known to reject the `tools` field: seeded, or
 *  learned within the TTL. A learned latch with no timestamp predates the TTL
 *  and counts as expired — those are exactly the ones that may be wrong. */
export function hasNoTools(baseURL: string | undefined, model: string, now: number = Date.now()): boolean {
  const key = storeKey(baseURL, model);
  if (SEED.get(key)?.noTools === true) return true;
  const learned = ensureLoaded().get(key);
  if (learned?.noTools !== true || !learned.noToolsAt) return false;
  return now - Date.parse(learned.noToolsAt) < NO_TOOLS_LATCH_TTL_MS;
}

/** Record that (baseURL, model) rejects tools. Persists through to disk. A
 *  fresh observation restamps an expired latch; a live one is not rewritten. */
export function recordNoTools(baseURL: string | undefined, model: string, now: number = Date.now()): void {
  const key = storeKey(baseURL, model);
  const map = ensureLoaded();
  const entry = map.get(key) ?? {};
  if (entry.noTools && entry.noToolsAt && now - Date.parse(entry.noToolsAt) < NO_TOOLS_LATCH_TTL_MS) return;
  entry.noTools = true;
  entry.noToolsAt = new Date(now).toISOString();
  map.set(key, entry);
  persist();
}

/** Drop a LEARNED no-tools latch — a model that just emitted a structured
 *  tool call is not tool-incapable. A seeded latch is untouched. */
export function clearNoTools(baseURL: string | undefined, model: string): void {
  const map = ensureLoaded();
  const entry = map.get(storeKey(baseURL, model));
  if (!entry?.noTools) return;
  delete entry.noTools;
  delete entry.noToolsAt;
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
 * The live-verified tool-calling observation for (baseURL, model), if any.
 * undefined = never verified. LEARNED-only — the seed carries no live
 * observations, so (unlike hasNoTools) there is no seed layer to consult.
 */
export function getToolsVerified(baseURL: string | undefined, model: string): ToolsVerified | undefined {
  const tv = ensureLoaded().get(storeKey(baseURL, model))?.toolsVerified;
  return tv ? { ...tv } : undefined;
}

/**
 * Record a live tool-verification observation. Persists through to disk.
 * Always writes: a re-verification is a fresh observation with a fresh
 * timestamp, not a redundant one.
 */
export function recordToolsVerified(baseURL: string | undefined, model: string, ok: boolean): void {
  const map = ensureLoaded();
  const key = storeKey(baseURL, model);
  const entry = map.get(key) ?? {};
  entry.toolsVerified = { ok, at: new Date().toISOString() };
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
