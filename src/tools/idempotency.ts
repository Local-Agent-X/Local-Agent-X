// Cross-session destructive-tool idempotency. Different from the
// within-op dedup phase in src/tool-execution/dedup-cache.ts:
//
//   - Axis 2 (dedup-cache):  scope = session/run, TTL = 60s, generic
//                            backstop wired into the tool-execution
//                            pipeline. Catches the MCP-loop class.
//   - Axis 3 (this module):  scope = global (process-local), TTL =
//                            minutes-to-hours, per-tool natural-key
//                            fingerprint. Catches "user retried 5 min
//                            later" / "different session same payload"
//                            duplicate sends.
//
// Both layers are intentional: Axis 2 fires before tool execution and
// returns the prior result; Axis 3 fires from INSIDE the tool's execute()
// and surfaces a "skipped — already done at <time>" message so the model
// understands it's a deliberate no-op, not a failure. Email_send and the
// social posts call this; the inert-side-effect tools rely on Axis 2.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

interface Entry {
  ts: number;
  result: string;
}

const store = new Map<string, Entry>();

// Cap the store by sweeping anything past the widest realistic window.
// 24h is well past the longest per-tool window and bounds memory under
// adversarial input. The same bound gates what survives a reload.
const SWEEP_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistence. The Map alone cannot survive a crash between the side effect
// (e.g. `transport.sendMail` resolving) and canonical-loop commitTurn
// persisting the turn: recovery re-drives the uncommitted turn, the tool
// re-executes, and an empty store means the transport fires TWICE. So
// markDone mirrors the store to disk and the first lookup after process
// start reloads it. Contents are hash-only keys (24-char sha256 prefixes) +
// timestamps + tool-result summaries that transcripts already persist —
// nothing beyond what the transcript holds. The in-memory Map stays
// authoritative for the process lifetime; disk is a crash-recovery
// backstop, so every disk failure below is warn-and-continue — a
// persistence failure must never fail a send.
// ---------------------------------------------------------------------------

let loaded = false;

function storeFile(): string {
  return join(getLaxDir(), "send-idempotency.json");
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const now = Date.now();
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf-8")) as Record<string, Entry>;
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v.ts !== "number" || typeof v.result !== "string") continue;
      if (now - v.ts > SWEEP_MS) continue; // GC expired entries on load
      if (!store.has(k)) store.set(k, v); // never clobber fresher in-memory state
    }
  } catch (err) {
    // ENOENT = first run, nothing persisted yet. Anything else (corrupt
    // JSON, permissions) degrades to process-local semantics.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[idempotency] could not load persisted store: ${(err as Error).message}`);
    }
  }
}

function persist(): void {
  // Full rewrite via tmp + rename: the store is small and TTL-bounded, and
  // rename keeps a crash mid-write from truncating the previous snapshot.
  try {
    mkdirSync(getLaxDir(), { recursive: true });
    const file = storeFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    console.warn(
      `[idempotency] could not persist store (the send itself succeeded): ${(err as Error).message}`,
    );
  }
}

function key(toolName: string, fingerprint: string): string {
  return createHash("sha256")
    .update(`${toolName}|${fingerprint}`)
    .digest("hex")
    .slice(0, 24);
}

function gc(now: number): void {
  for (const [k, v] of store) {
    if (now - v.ts > SWEEP_MS) store.delete(k);
  }
}

/** Look up whether (toolName, fingerprint) has been recorded within the
 *  caller's window. Returns the prior result string + the age in ms on
 *  hit, null on miss. */
export function recentlyDone(
  toolName: string,
  fingerprint: string,
  windowMs: number,
): { result: string; ageMs: number } | null {
  ensureLoaded();
  const now = Date.now();
  gc(now);
  const entry = store.get(key(toolName, fingerprint));
  if (!entry) return null;
  const ageMs = now - entry.ts;
  if (ageMs >= windowMs) return null;
  return { result: entry.result, ageMs };
}

/** Record a completed destructive call. Caller must only invoke AFTER
 *  the side effect actually happened (e.g. after `transport.sendMail`
 *  resolves successfully) so a failed attempt doesn't block legitimate
 *  retry. */
export function markDone(toolName: string, fingerprint: string, result: string): void {
  ensureLoaded();
  const now = Date.now();
  gc(now);
  store.set(key(toolName, fingerprint), { ts: now, result });
  persist();
}

/** Build a stable fingerprint from arbitrary string parts. Empty parts
 *  collapse to "" so callers don't have to filter; whitespace at the
 *  edges is trimmed. */
export function fingerprintOf(...parts: string[]): string {
  const normalized = parts.map(p => (p ?? "").trim()).join("");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Format a "how long ago" string for the duplicate-skipped message. */
export function describeAge(ageMs: number): string {
  if (ageMs < 1000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} min ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}

/** Test-only: drop the entire store, including the persisted snapshot, and
 *  mark the module loaded so nothing is lazily re-read. Preserves the
 *  pre-persistence semantics existing tests rely on: after a clear, every
 *  lookup misses. */
export function _clearIdempotencyStoreForTests(): void {
  store.clear();
  loaded = true;
  try {
    rmSync(storeFile(), { force: true });
  } catch {
    // Best effort — an unreadable data dir just means nothing was persisted.
  }
}

/** Test-only: simulate a process restart. Drops the in-memory Map and the
 *  loaded flag but leaves the persisted snapshot on disk, so the next
 *  recentlyDone/markDone lazily reloads it — the crash re-drive path.
 *  Naming mirrors _resetMasterKeyCacheForTests. */
export function _resetIdempotencyForTests(): void {
  store.clear();
  loaded = false;
}
