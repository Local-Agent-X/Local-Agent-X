import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.js";
import { readSessionLog, writeSessionLog } from "./session-message-log.js";

// A message object carries only role and content, so its row's createdAt is
// the only record of when it was said. The writer rewrites the whole file on
// every save and used to stamp every row with the save time, so one save
// erased every earlier message's time (chat-muuow8r4, 2026-10-07: 62 rows,
// one createdAt), and a search then dated a message from that morning by the
// day the chat began.
describe("writeSessionLog keeps each message's original time", () => {
  let dir: string;
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  const rowTimes = (id: string) =>
    readFileSync(join(dir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.kind === "msg").map((r) => r.createdAt as string);

  it("a later save stamps only the new message; earlier ones keep their time (cached session)", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-session-times-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T03:28:00Z"));
    const s: Session = { id: "chat-t", title: "t", createdAt: Date.now(), updatedAt: Date.now(), messages: [
      { role: "user", content: "first" }, { role: "assistant", content: "reply" },
    ] };
    writeSessionLog(dir, s);
    vi.setSystemTime(new Date("2026-10-07T17:28:00Z"));
    s.messages.push({ role: "user", content: "car ride today" });
    writeSessionLog(dir, s);
    writeSessionLog(dir, s);
    expect(rowTimes("chat-t")).toEqual(["2026-10-05T03:28:00.000Z", "2026-10-05T03:28:00.000Z", "2026-10-07T17:28:00.000Z"]);
  });

  it("times survive a fresh load and re-save (a restart), including after a turn that filters the array", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-session-times-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T03:28:00Z"));
    writeSessionLog(dir, { id: "chat-r", title: "r", createdAt: Date.now(), updatedAt: Date.now(), messages: [
      { role: "user", content: "first" }, { role: "assistant", content: "reply" },
    ] });
    vi.setSystemTime(new Date("2026-10-07T19:30:00Z"));
    const loaded = readSessionLog(dir, "chat-r")!;
    // The chat turn rebuilds the array by filtering, keeping the same objects.
    loaded.messages = [...loaded.messages, { role: "user" as const, content: "new" }].filter(() => true);
    writeSessionLog(dir, loaded);
    expect(rowTimes("chat-r")).toEqual(["2026-10-05T03:28:00.000Z", "2026-10-05T03:28:00.000Z", "2026-10-07T19:30:00.000Z"]);
  });
});
