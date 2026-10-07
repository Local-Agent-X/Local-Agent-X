import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionLogRows, sessionLogDate, sessionLogMeta } from "./session-log-rows.js";

// The one reader of the session log format. Every consumer — the session
// store, the indexers, consolidation — projects from these rows, so the rules
// that used to be re-implemented per consumer are pinned here once.
describe("session-log-rows", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (lines: string[]) => {
    dir = mkdtempSync(join(tmpdir(), "lax-log-rows-"));
    const p = join(dir, "chat-x.jsonl");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  };
  const meta = (createdAt: number, title: string) => JSON.stringify({ kind: "meta", id: "chat-x", title, createdAt, updatedAt: createdAt });
  const msg = (role: string, content: string) => JSON.stringify({ kind: "msg", message: { role, content }, createdAt: "2026-10-07T17:28:00.000Z" });

  it("keeps rows in file order and skips a torn line", () => {
    const rows = readSessionLogRows(write([meta(Date.UTC(2026, 9, 5), "t"), msg("user", "hi"), '{"kind":"msg","mess', msg("assistant", "yo")]))!;
    expect(rows.map((r) => r.kind)).toEqual(["meta", "msg", "msg"]);
  });

  it("the LAST meta row is authoritative, and dates the session", () => {
    const p = write([meta(Date.UTC(2026, 9, 1), "old"), msg("user", "hi"), meta(Date.UTC(2026, 9, 5), "new")]);
    expect(sessionLogMeta(readSessionLogRows(p)!)?.title).toBe("new");
    expect(sessionLogDate(p)).toBe("2026-10-05");
  });

  it("an unreadable file is null, a log with no meta has no date", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-log-rows-"));
    expect(readSessionLogRows(join(dir, "missing.jsonl"))).toBeNull();
    expect(sessionLogDate(write([msg("user", "hi")]))).toBeUndefined();
  });
});
