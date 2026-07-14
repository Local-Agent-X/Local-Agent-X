/**
 * WAL checkpointing for memory.db.
 *
 * Nothing ever checkpointed memory.db, so the WAL grew unbounded (observed
 * 485MB) and was replayed on every open — 30s boot stalls. MemoryIndex now
 * runs PRAGMA wal_checkpoint(TRUNCATE) at construction (no other readers
 * exist yet) and exposes checkpoint() for idle-time hygiene. A busy result
 * (readonly snapshot connections hold the WAL) is a normal outcome, never an
 * exception.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MemoryIndex } from "./index.js";

let tempDir: string;
let memory: MemoryIndex | null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-wal-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory?.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function db(): InstanceType<typeof Database> {
  return (memory as unknown as { db: InstanceType<typeof Database> }).db;
}

function walPath(): string {
  return join(tempDir, "memory.db-wal");
}

function walSize(): number {
  return existsSync(walPath()) ? statSync(walPath()).size : 0;
}

// Bulk-insert chunk rows so the WAL accumulates real frames.
function growWal(handle: InstanceType<typeof Database>, rows = 500): void {
  const insert = handle.prepare(
    "INSERT INTO chunks (path, source, start_line, end_line, text, hash, embedding, updated_at) VALUES (?, 'memory', 0, 1, ?, ?, NULL, ?)",
  );
  const text = "wal-growth-payload ".repeat(64);
  const now = Date.now();
  handle.transaction(() => {
    for (let i = 0; i < rows; i++) {
      insert.run(`virtual://wal-test/${i}.md`, text, `hash-${i}`, now);
    }
  })();
}

describe("MemoryIndex WAL checkpointing", () => {
  it("checkpoint() truncates a grown WAL back to ~0 bytes", () => {
    growWal(db());
    const before = walSize();
    expect(before).toBeGreaterThan(100 * 1024);

    const result = memory!.checkpoint();

    expect(result.busy).toBe(0);
    expect(result.checkpointed).toBe(result.log);
    expect(walSize()).toBe(0);
  });

  it("boot-time construction truncates a WAL left behind by a previous run", () => {
    growWal(db());
    expect(walSize()).toBeGreaterThan(100 * 1024);

    // A lingering readonly connection prevents the closing writer from
    // checkpointing + deleting the WAL, and a readonly connection cannot
    // checkpoint on its own close — so the bloated WAL survives on disk,
    // exactly like a run that died with snapshot readers attached.
    const reader = new Database(join(tempDir, "memory.db"), { readonly: true });
    reader.prepare("SELECT COUNT(*) FROM chunks").get();
    memory!.close();
    memory = null;
    reader.close();
    const leftover = walSize();
    expect(leftover).toBeGreaterThan(100 * 1024);

    memory = new MemoryIndex(tempDir, { minScore: -1 });

    // Schema init re-runs after the boot checkpoint, so a few fresh frames
    // may exist — but the previous run's megabytes must be gone.
    expect(walSize()).toBeLessThan(leftover / 10);
    expect(walSize()).toBeLessThan(64 * 1024);
  });

  it("checkpoint() with an open readonly read statement returns busy/partial, never throws", () => {
    growWal(db());
    // Keep the busy wait short — the checkpoint would otherwise spin the
    // 5000ms busy_timeout before conceding.
    db().pragma("busy_timeout = 100");

    const reader = new Database(join(tempDir, "memory.db"), { readonly: true });
    const iter = reader.prepare("SELECT id FROM chunks").iterate();
    try {
      iter.next(); // pull one row — the read transaction stays open
      const result = memory!.checkpoint();
      expect(result.busy).toBe(1);
      expect(walSize()).toBeGreaterThan(0);
    } finally {
      iter.return?.();
      reader.close();
    }
  });
});
