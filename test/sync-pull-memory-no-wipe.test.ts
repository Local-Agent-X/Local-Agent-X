import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullMemoryDir } from "../src/sync/pull-files/pull-memory.js";
import { readSyncedNotes, recordSyncedNotes } from "../src/sync/synced-notes.js";

// Seam: sync pull → memory delete-reconciliation → local memory dir on disk.
// Regression (C2): the delete loop reconciled against `remoteMemFiles`, which
// only gets populated when the remote memory/ dir EXISTS. When it did not
// (fresh/empty sync repo), the set stayed empty and every local memory/*.md
// was deleted — and the startup pull runs before the first push, so pointing
// sync at a new empty repo and restarting wiped all local notes forever.
describe("pullMemoryDir — no wipe when remote has no memory dir", () => {
  let dataDir: string;
  let syncDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-nowipe-data-"));
    syncDir = mkdtempSync(join(tmpdir(), "lax-nowipe-sync-"));
    mkdirSync(join(dataDir, "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(syncDir, { recursive: true, force: true });
  });

  const writeLocal = (name: string, content: string): void =>
    writeFileSync(join(dataDir, "memory", name), content, "utf-8");

  it("keeps local notes when the remote sync dir has no memory/ subdir", () => {
    writeLocal("note-a.md", "local note a");
    writeLocal("note-b.md", "local note b");

    // syncDir has NO memory/ subdir — a fresh/empty sync repo.
    pullMemoryDir(dataDir, syncDir);

    expect(existsSync(join(dataDir, "memory", "note-a.md"))).toBe(true);
    expect(existsSync(join(dataDir, "memory", "note-b.md"))).toBe(true);
  });

  it("still removes a note the remote held at the last sync and no longer does", () => {
    writeLocal("note-a.md", "local note a");
    writeLocal("note-b.md", "local note b");
    // Both notes were in the repo at this machine's last push or pull.
    recordSyncedNotes(dataDir, ["note-a.md", "note-b.md"]);

    // Remote memory/ exists and contains only note-a.md → note-b was truly
    // removed remotely and must be reconciled away. This proves the fix did
    // not neuter the genuine "file removed from remote" behavior.
    mkdirSync(join(syncDir, "memory"), { recursive: true });
    writeFileSync(join(syncDir, "memory", "note-a.md"), "remote note a", "utf-8");

    pullMemoryDir(dataDir, syncDir);

    expect(existsSync(join(dataDir, "memory", "note-a.md"))).toBe(true);
    expect(existsSync(join(dataDir, "memory", "note-b.md"))).toBe(false);
  });

  // 2026-11-13: pushes had not run for days, and every startup pull deleted the
  // day's note (2026-11-13.md) because the remote did not have it yet.
  it("keeps a note written here that never reached the remote", () => {
    writeLocal("2026-11-12.md", "yesterday, pushed");
    writeLocal("2026-11-13.md", "today, not pushed yet");
    recordSyncedNotes(dataDir, ["2026-11-12.md"]);
    mkdirSync(join(syncDir, "memory"), { recursive: true });
    writeFileSync(join(syncDir, "memory", "2026-11-12.md"), "yesterday, pushed", "utf-8");

    pullMemoryDir(dataDir, syncDir);

    expect(readFileSync(join(dataDir, "memory", "2026-11-13.md"), "utf-8")).toBe("today, not pushed yet");
  });

  it("deletes nothing on a machine with no record yet, then records what the remote holds", () => {
    writeLocal("note-b.md", "local note b");
    mkdirSync(join(syncDir, "memory"), { recursive: true });
    writeFileSync(join(syncDir, "memory", "note-a.md"), "remote note a", "utf-8");

    pullMemoryDir(dataDir, syncDir);

    expect(existsSync(join(dataDir, "memory", "note-b.md"))).toBe(true);
    expect([...(readSyncedNotes(dataDir) ?? [])]).toEqual(["note-a.md"]);
  });
});
