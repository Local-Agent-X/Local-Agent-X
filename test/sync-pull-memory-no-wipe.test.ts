import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullMemoryDir } from "../src/sync/pull-files/pull-memory.js";

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

  it("still removes a note absent from a PRESENT remote memory dir", () => {
    writeLocal("note-a.md", "local note a");
    writeLocal("note-b.md", "local note b");

    // Remote memory/ exists and contains only note-a.md → note-b was truly
    // removed remotely and must be reconciled away. This proves the fix did
    // not neuter the genuine "file removed from remote" behavior.
    mkdirSync(join(syncDir, "memory"), { recursive: true });
    writeFileSync(join(syncDir, "memory", "note-a.md"), "remote note a", "utf-8");

    pullMemoryDir(dataDir, syncDir);

    expect(existsSync(join(dataDir, "memory", "note-a.md"))).toBe(true);
    expect(existsSync(join(dataDir, "memory", "note-b.md"))).toBe(false);
  });
});
