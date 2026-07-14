/**
 * SessionStore.archiveOldSessions — move-only retention.
 *
 * Regression for "sessions accumulate forever": nothing pruned the sessions
 * dir (~3000 files / 347MB observed). Policy: sessions whose .jsonl mtime is
 * older than the window are MOVED to <dataDir>/sessions-archive/ — never
 * deleted — and disappear from list(); recent sessions are untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import type { Session } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dataDir: string;
let store: SessionStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-session-archive-"));
  store = new SessionStore(dataDir);
});

afterEach(() => {
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

describe("SessionStore.archiveOldSessions", () => {
  it("moves old sessions to sessions-archive (content intact), leaves recent ones, updates list()", () => {
    store.save(makeSession("old-a"));
    store.save(makeSession("recent-b"));
    const original = readFileSync(join(dataDir, "sessions", "old-a.jsonl"), "utf-8");
    backdate("old-a", 100);

    const r = store.archiveOldSessions(90);

    expect(r).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(existsSync(join(dataDir, "sessions", "old-a.jsonl"))).toBe(false);
    expect(readFileSync(join(dataDir, "sessions-archive", "old-a.jsonl"), "utf-8")).toBe(original);
    expect(existsSync(join(dataDir, "sessions", "recent-b.jsonl"))).toBe(true);
    const ids = store.list().map((s) => s.id);
    expect(ids).not.toContain("old-a");
    expect(ids).toContain("recent-b");
    // The persisted metadata cache agrees — a fresh store doesn't resurrect it.
    expect(new SessionStore(dataDir).list().map((s) => s.id)).not.toContain("old-a");
  });

  it("never touches a session written within the last 24h, even with a tiny window", () => {
    store.save(makeSession("live"));
    const r = store.archiveOldSessions(0);
    expect(r.archived).toBe(0);
    expect(existsSync(join(dataDir, "sessions", "live.jsonl"))).toBe(true);
  });

  it("archive-name collision fails that session only, deleting nothing", () => {
    store.save(makeSession("clash"));
    backdate("clash", 100);
    mkdirSync(join(dataDir, "sessions-archive"), { recursive: true });
    writeFileSync(join(dataDir, "sessions-archive", "clash.jsonl"), "pre-existing archive copy\n");

    const r = store.archiveOldSessions(90);

    expect(r.failed).toBe(1);
    expect(existsSync(join(dataDir, "sessions", "clash.jsonl"))).toBe(true);
    expect(readFileSync(join(dataDir, "sessions-archive", "clash.jsonl"), "utf-8")).toBe("pre-existing archive copy\n");
  });

  it("rolls the move back when onArchived throws — file home, session still listed", () => {
    store.save(makeSession("linked"));
    store.save(makeSession("solo"));
    backdate("linked", 100);
    backdate("solo", 100);

    const r = store.archiveOldSessions(90, (oldPath) => {
      if (oldPath.includes("linked")) throw new Error("repoint failed");
    });

    expect(r).toEqual({ archived: 1, skipped: 0, failed: 1 });
    // Rolled back: file back in sessions/, still listed, nothing in archive.
    expect(existsSync(join(dataDir, "sessions", "linked.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "sessions-archive", "linked.jsonl"))).toBe(false);
    expect(store.list().map((s) => s.id)).toContain("linked");
    // The healthy sibling still archived.
    expect(existsSync(join(dataDir, "sessions-archive", "solo.jsonl"))).toBe(true);
  });

  it("carries the legacy .json.pre-migration sidecar along with the session", () => {
    store.save(makeSession("legacy"));
    writeFileSync(join(dataDir, "sessions", "legacy.json.pre-migration"), "{}");
    backdate("legacy", 100);

    const r = store.archiveOldSessions(90);

    expect(r.archived).toBe(1);
    expect(existsSync(join(dataDir, "sessions-archive", "legacy.json.pre-migration"))).toBe(true);
    expect(existsSync(join(dataDir, "sessions", "legacy.json.pre-migration"))).toBe(false);
  });

  it("a directory masquerading as {id}.jsonl is skipped, not moved", () => {
    const dir = join(dataDir, "sessions", "not-a-file.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "inner.txt"), "keep me");
    const when = new Date(Date.now() - 100 * DAY_MS);
    utimesSync(dir, when, when);

    const r = store.archiveOldSessions(90);

    expect(r.skipped).toBe(1);
    expect(r.archived).toBe(0);
    expect(readFileSync(join(dir, "inner.txt"), "utf-8")).toBe("keep me");
  });
});
