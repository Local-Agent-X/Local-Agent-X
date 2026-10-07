import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { buildSessionChunks } from "./chunking.js";

// A session becomes search chunks one way (buildSessionChunks), and each chunk
// carries its messages' provenance: their ids and the exact time the exchange
// began. Before this the sync pass, the transcript indexer and the live pass
// each paired and dated a session themselves — a message was dated by the
// day its chat began (2026-10-07), and the live pass indexed every exchange
// a second time under a session-live/ path.
let dir: string;
let memory: MemoryIndex;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-session-chunks-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(dir);
});
afterEach(() => { try { memory.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const START = Date.UTC(2026, 9, 5, 3, 28);
function writeSession(rows: object[]): string {
  const path = join(dir, "sessions", "chat-a.jsonl");
  writeFileSync(path, [JSON.stringify({ kind: "meta", id: "chat-a", title: "a", createdAt: START, updatedAt: START }),
    ...rows.map((r) => JSON.stringify({ kind: "msg", ...r }))].join("\n") + "\n");
  return path;
}
const msg = (role: string, content: string, id: string, createdAt: string, timeUnknown?: true) =>
  ({ id, message: { role, content }, createdAt, ...(timeUnknown ? { timeUnknown } : {}) });

describe("buildSessionChunks — provenance per exchange", () => {
  it("dates each exchange by its own message, carries its message ids, and flags an unknown time", () => {
    const path = writeSession([
      msg("user", "Things have gotten rather interesting", "um-1", "2026-10-05T03:28:14.000Z"),
      msg("assistant", "What's been going on?", "am-1", "2026-10-05T03:28:18.000Z"),
      msg("user", "but he was hedging his bet", "sm-x", "2026-10-07T17:28:35.570Z", true),
      msg("assistant", "You're right, I missed that.", "sm-y", "2026-10-07T17:28:35.570Z", true),
      msg("user", "We have another long car ride today", "um-2", "2026-10-07T17:28:16.608Z"),
      msg("assistant", "The 2011 story?", "am-2", "2026-10-07T17:28:34.000Z"),
    ]);
    const meta = buildSessionChunks(path, "chat-a").map((c) => c.metadata);
    expect(meta[0]).toMatchObject({ session_id: "chat-a", source_type: "agent-x-session", message_ids: ["um-1", "am-1"], datetime: "2026-10-05T03:28:14.000Z", date: "2026-10-05" });
    expect(meta[1]).toMatchObject({ message_ids: ["sm-x", "sm-y"], date: "2026-10-05", date_approx: true });
    expect(meta[1]).not.toHaveProperty("datetime");
    expect(meta[2]).toMatchObject({ message_ids: ["um-2", "am-2"], datetime: "2026-10-07T17:28:16.608Z", date: "2026-10-07" });
  });
});

describe("one indexing path for a session", () => {
  it("indexing twice through the builder stores one copy, under the session file, and re-dating refreshes metadata in place", async () => {
    const path = writeSession([
      msg("user", "car ride today", "um-2", "2026-10-07T17:28:35.570Z", true),
      msg("assistant", "the 2011 story?", "am-2", "2026-10-07T17:28:35.570Z", true),
    ]);
    await memory.indexChunksIdempotent(buildSessionChunks(path, "chat-a"), path, "session");
    const db = memory["db"] as InstanceType<typeof import("better-sqlite3")>;
    const rows = () => db.prepare("SELECT id, path, metadata FROM chunks WHERE session_id = 'chat-a'").all() as Array<{ id: number; path: string; metadata: string }>;
    const before = rows();
    expect(before).toHaveLength(1);
    expect(before[0].path).toBe(path);
    expect(JSON.parse(before[0].metadata)).toMatchObject({ date_approx: true });

    // The backfill recovers the real time; the text is unchanged.
    writeSession([
      msg("user", "car ride today", "um-2", "2026-10-07T17:28:16.608Z"),
      msg("assistant", "the 2011 story?", "am-2", "2026-10-07T17:28:34.000Z"),
    ]);
    const r = await memory.indexChunksIdempotent(buildSessionChunks(path, "chat-a"), path, "session");
    expect(r).toMatchObject({ added: 0, removed: 0 });
    const after = rows();
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id));
    const m = JSON.parse(after[0].metadata);
    expect(m).toMatchObject({ datetime: "2026-10-07T17:28:16.608Z", date: "2026-10-07" });
    expect(m).not.toHaveProperty("date_approx");
    expect(db.prepare("SELECT count(*) AS n FROM chunks WHERE path LIKE 'session-live/%'").get()).toEqual({ n: 0 });
  });
});
