/**
 * memory-hygiene job — end-to-end against a real temp dataDir.
 *
 * Regression for "nothing maintains ~/.lax data": embedding_cache was pruned
 * only during full sync, the WAL only checkpointed at boot, and sessions
 * accumulated forever. One run of the job must prune the cache to its cap,
 * truncate the WAL, and archive (never delete) >90d sessions — and a bad
 * session file must not abort the rest of the sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../memory/index.js";
import { SessionStore } from "../../memory/session-store.js";
import type { Session } from "../../types.js";
import { makeRunMemoryHygiene, SESSION_ARCHIVE_MAX_AGE_DAYS } from "./memory-hygiene.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_CAP = 5;

let dataDir: string;
let memoryIndex: MemoryIndex;
let sessionStore: SessionStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-hygiene-"));
  memoryIndex = new MemoryIndex(dataDir, { minScore: -1, embeddingCacheMaxEntries: CACHE_CAP });
  sessionStore = new SessionStore(dataDir);
});

afterEach(() => {
  try { memoryIndex.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

function makeSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: "user", content: `hello from ${id}` }],
  };
}

function backdate(id: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(join(dataDir, "sessions", `${id}.jsonl`), when, when);
}

function cacheCount(): number {
  const db = memoryIndex.maintenanceDb();
  return (db.prepare("SELECT COUNT(*) AS n FROM embedding_cache").get() as { n: number }).n;
}

describe("memory-hygiene job", () => {
  it("prunes embedding_cache, truncates the WAL, and archives only >90d sessions", async () => {
    // Seed the cache past its cap — these writes also grow the WAL.
    const db = memoryIndex.maintenanceDb();
    const ins = db.prepare(
      "INSERT INTO embedding_cache (hash, provider, model, embedding, updated_at) VALUES (?, 'fake', 'm1', '[0.1]', ?)",
    );
    for (let i = 0; i < CACHE_CAP * 2; i++) ins.run(`h-${i}`, Date.now() + i);
    expect(cacheCount()).toBe(CACHE_CAP * 2);
    expect(statSync(join(dataDir, "memory.db-wal")).size).toBeGreaterThan(0);

    sessionStore.save(makeSession("ancient"));
    sessionStore.save(makeSession("fresh"));
    const original = readFileSync(join(dataDir, "sessions", "ancient.jsonl"), "utf-8");
    backdate("ancient", SESSION_ARCHIVE_MAX_AGE_DAYS + 10);

    await makeRunMemoryHygiene({ dataDir, sessionStore, memoryIndex })();

    // Cache pruned to cap (LRU — newest survive).
    expect(cacheCount()).toBe(CACHE_CAP);
    // WAL truncated back to zero.
    expect(statSync(join(dataDir, "memory.db-wal")).size).toBe(0);
    // busy_timeout restored to the store's operating default after the wrap.
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    // Old session moved — content intact, never deleted.
    expect(existsSync(join(dataDir, "sessions", "ancient.jsonl"))).toBe(false);
    expect(readFileSync(join(dataDir, "sessions-archive", "ancient.jsonl"), "utf-8")).toBe(original);
    // Recent session untouched and still listed; archived one gone from list().
    expect(existsSync(join(dataDir, "sessions", "fresh.jsonl"))).toBe(true);
    const ids = sessionStore.list().map((s) => s.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("ancient");
  });

  it("a bad session file doesn't abort the sweep — the others still archive", async () => {
    // "Bad" = archive-name collision: the job must fail that one session
    // without deleting either copy, and still archive its sibling.
    sessionStore.save(makeSession("stuck"));
    sessionStore.save(makeSession("movable"));
    backdate("stuck", 120);
    backdate("movable", 120);
    mkdirSync(join(dataDir, "sessions-archive"), { recursive: true });
    writeFileSync(join(dataDir, "sessions-archive", "stuck.jsonl"), "pre-existing\n");

    await makeRunMemoryHygiene({ dataDir, sessionStore, memoryIndex })();

    // Sibling archived despite the failure.
    expect(existsSync(join(dataDir, "sessions-archive", "movable.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "sessions", "movable.jsonl"))).toBe(false);
    // Collided session: both copies intact — nothing deleted, nothing clobbered.
    expect(existsSync(join(dataDir, "sessions", "stuck.jsonl"))).toBe(true);
    expect(readFileSync(join(dataDir, "sessions-archive", "stuck.jsonl"), "utf-8")).toBe("pre-existing\n");
  });

  it("is a no-op on a quiet store — nothing archived, job completes", async () => {
    sessionStore.save(makeSession("only"));
    await makeRunMemoryHygiene({ dataDir, sessionStore, memoryIndex })();
    expect(existsSync(join(dataDir, "sessions", "only.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "sessions-archive"))).toBe(false);
  });
});
