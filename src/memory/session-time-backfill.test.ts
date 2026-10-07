import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAllSessions, planAllSessions } from "./session-time-backfill.js";
import { readSessionLog, writeSessionLog } from "./session-message-log.js";

// Before 2026-10-07 every save re-stamped every message with the save time.
// The op records kept the truth: each chat turn's user message and when the
// turn started and finished. These pin the repair that writes it back.
describe("session time backfill", () => {
  let lax: string;
  afterEach(() => rmSync(lax, { recursive: true, force: true }));

  const RESAVED = "2026-10-07T17:28:35.570Z";
  const meta = JSON.stringify({ kind: "meta", id: "chat-a", title: "a", createdAt: Date.UTC(2026, 9, 5), updatedAt: 0 });
  const row = (message: object) => JSON.stringify({ kind: "msg", message, createdAt: RESAVED });
  function setup() {
    lax = mkdtempSync(join(tmpdir(), "lax-backfill-"));
    mkdirSync(join(lax, "sessions"));
    const log = [
      meta,
      row({ role: "user", content: "Things have gotten rather interesting" }),
      row({ role: "assistant", content: "What's been going on?" }),
      row({ role: "user", content: "a voice turn with no op" }),
      row({ role: "assistant", content: "reply to it" }),
      row({ role: "user", content: "We have another long car ride today" }),
      row({ role: "user", content: "[nudge]", _harness: "nudge" }),
      row({ role: "assistant", content: "the 2011 story?" }),
      JSON.stringify({ kind: "checkpoint", summary: "s", coversThrough: 1, createdAt: RESAVED }),
    ].join("\n") + "\n";
    writeFileSync(join(lax, "sessions", "chat-a.jsonl"), log);
    const op = (id: string, task: string, createdAt: string, completedAt: string) => {
      mkdirSync(join(lax, "operations", id), { recursive: true });
      writeFileSync(join(lax, "operations", id, "operation.json"), JSON.stringify({ sessionId: "chat-a", task, createdAt, completedAt }));
    };
    op("op_chat_turn_1", "Things have gotten rather interesting", "2026-10-05T03:28:12.000Z", "2026-10-05T03:28:19.000Z");
    op("op_chat_turn_2", "We have another long car ride today", "2026-10-07T15:28:16.000Z", "2026-10-07T15:28:30.000Z");
    return log;
  }

  it("dates each matched turn by its op, keeps a harness nudge inside its turn, marks an unmatched turn unknown", () => {
    setup();
    const [plan] = planAllSessions(lax);
    expect(plan).toMatchObject({ sessionId: "chat-a", turns: 3, matched: 2, unknown: 1 });
    expect(plan.times.map((t) => t.createdAt)).toEqual([
      "2026-10-05T03:28:12.000Z", "2026-10-05T03:28:19.000Z",
      null, null,
      "2026-10-07T15:28:16.000Z", "2026-10-07T15:28:30.000Z", "2026-10-07T15:28:30.000Z",
    ]);
  });

  it("apply backs up first, rewrites only msg rows, and the marker survives the next save", () => {
    const original = setup();
    const backup = applyAllSessions(lax, planAllSessions(lax), "t");
    expect(readFileSync(join(backup, "chat-a.jsonl"), "utf8")).toBe(original);
    const rows = readFileSync(join(lax, "sessions", "chat-a.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows[0]).toEqual(JSON.parse(meta));
    expect(rows[8].kind).toBe("checkpoint");
    expect(rows[3]).toMatchObject({ createdAt: RESAVED, timeUnknown: true });
    expect(rows[5].createdAt).toBe("2026-10-07T15:28:16.000Z");

    // A later save by the app keeps both the recovered times and the marker.
    const session = readSessionLog(join(lax, "sessions"), "chat-a")!;
    writeSessionLog(join(lax, "sessions"), session);
    const after = readFileSync(join(lax, "sessions", "chat-a.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "msg");
    expect(after[0].createdAt).toBe("2026-10-05T03:28:12.000Z");
    expect(after[2]).toMatchObject({ timeUnknown: true });
    expect(after[3]).toMatchObject({ timeUnknown: true });
    expect(after[4].createdAt).toBe("2026-10-07T15:28:16.000Z");
  });

  it("re-running the plan after apply changes nothing (idempotent)", () => {
    setup();
    applyAllSessions(lax, planAllSessions(lax), "t1");
    const once = readFileSync(join(lax, "sessions", "chat-a.jsonl"), "utf8");
    applyAllSessions(lax, planAllSessions(lax), "t2");
    expect(readFileSync(join(lax, "sessions", "chat-a.jsonl"), "utf8")).toBe(once);
    expect(existsSync(join(lax, "backups", "session-times-t2"))).toBe(true);
  });
});
