/**
 * A compaction checkpoint shortens the REQUEST, never the transcript.
 *
 * The obvious way to persist an automatic summary was the existing `summary`
 * row — and it would have deleted user data: that row's read path drops every
 * msg row before it, because a user-invoked /api/compact means "forget the
 * details". Automatic compaction means "don't re-send the details", which is a
 * different thing entirely. The difference is invisible until someone scrolls
 * up and their conversation is gone, so it gets its own row kind and this test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionLog, writeSessionLog } from "./session-message-log.js";
import { COMPACTION_PREFIX, type Session } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-checkpoint-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const msg = (role: "user" | "assistant", content: string): ChatCompletionMessageParam =>
  ({ role, content } as ChatCompletionMessageParam);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-check",
    title: "t",
    createdAt: 1,
    updatedAt: 2,
    messages: [
      msg("user", "first thing"), msg("assistant", "ok"),
      msg("user", "second thing"), msg("assistant", "done"),
    ],
    ...overrides,
  } as Session;
}

describe("checkpoint round trip", () => {
  it("keeps every message on disk and in the projection", () => {
    writeSessionLog(dir, session({ compactionCheckpoint: { summary: "earlier: set up the CRM", coversThrough: 2 } }));
    const back = readSessionLog(dir, "s-check")!;
    expect(back.messages).toHaveLength(4);
    expect(String(back.messages[0].content)).toBe("first thing");
    expect(back.compactionCheckpoint).toEqual({ summary: "earlier: set up the CRM", coversThrough: 2 });
  });

  it("is NOT a summary row — the file still carries the covered messages", () => {
    writeSessionLog(dir, session({ compactionCheckpoint: { summary: "gist", coversThrough: 2 } }));
    const raw = readFileSync(join(dir, "s-check.jsonl"), "utf8");
    expect(raw).toContain("first thing");
    expect(raw).toContain('"kind":"checkpoint"');
    expect(raw).not.toContain('"kind":"summary"');
  });

  it("a session with no checkpoint reads back without one", () => {
    writeSessionLog(dir, session());
    expect(readSessionLog(dir, "s-check")!.compactionCheckpoint).toBeUndefined();
  });

  it("ignores a checkpoint that reaches past the end (a retract shortened the transcript)", () => {
    writeSessionLog(dir, session({ compactionCheckpoint: { summary: "gist", coversThrough: 9 } }));
    const back = readSessionLog(dir, "s-check")!;
    expect(back.compactionCheckpoint, "a summary covering messages nobody has must not be trusted").toBeUndefined();
    expect(back.messages).toHaveLength(4);
  });

  it("a manual /api/compact supersedes it — that row really does rewrite the transcript", () => {
    const compacted = session({
      messages: [
        msg("assistant", "x"), // placeholder, replaced below
      ],
      compactionCheckpoint: { summary: "auto gist", coversThrough: 1 },
    });
    // The compact route's shape: a leading system row carrying the marker.
    compacted.messages = [
      { role: "system", content: `${COMPACTION_PREFIX} earlier turns]\nthe gist` } as ChatCompletionMessageParam,
      msg("user", "after the compact"),
    ];
    writeSessionLog(dir, compacted);
    const back = readSessionLog(dir, "s-check")!;
    expect(back.compactionCheckpoint, "the checkpoint described a transcript that no longer exists").toBeUndefined();
    expect(back.messages).toHaveLength(2);
  });

  it("survives a rewrite that carries it forward", () => {
    writeSessionLog(dir, session({ compactionCheckpoint: { summary: "gist", coversThrough: 2 } }));
    const back = readSessionLog(dir, "s-check")!;
    back.messages.push(msg("user", "third thing"));
    writeSessionLog(dir, back);
    const again = readSessionLog(dir, "s-check")!;
    expect(again.messages).toHaveLength(5);
    expect(again.compactionCheckpoint).toEqual({ summary: "gist", coversThrough: 2 });
  });
});
