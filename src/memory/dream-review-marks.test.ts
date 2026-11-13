import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EARLIER_CONTEXT_MESSAGES, countUnreviewedSessions, readUnreviewedSessions, withReviewed, type ReviewMarks,
} from "./dream-review-marks.js";
import { formatTranscriptForPrompt } from "./dream.js";

const T = Date.UTC(2026, 10, 12);
let dir: string;
const empty = (from = 0): ReviewMarks => ({ from, sessions: {} });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-dream-marks-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function row(role: "user" | "assistant", content: string): string {
  return JSON.stringify({ kind: "msg", message: { role, content }, createdAt: new Date(T).toISOString() }) + "\n";
}

/** A session log with `n` alternating user/assistant messages, dated `at`. */
function session(id: string, n: number, at: number, start = 0): string {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ kind: "meta", id, title: id, createdAt: at, updatedAt: at }) + "\n");
  for (let i = start; i < start + n; i++) appendFileSync(path, row(i % 2 === 0 ? "user" : "assistant", `${id} message ${i}`));
  touch(id, at);
  return path;
}

function grow(id: string, from: number, n: number, at: number): void {
  const path = join(dir, `${id}.jsonl`);
  for (let i = from; i < from + n; i++) appendFileSync(path, row(i % 2 === 0 ? "user" : "assistant", `${id} message ${i}`));
  touch(id, at);
}

function touch(id: string, at: number): void {
  utimesSync(join(dir, `${id}.jsonl`), at / 1000, at / 1000);
}

describe("dream reads each session once", () => {
  it("sends nothing from a session a finished dream read and that has not changed since", () => {
    session("chat-a", 4, T);
    const first = readUnreviewedSessions(dir, empty(), 10);
    expect(first.map((t) => t.pairs.length)).toEqual([4]);
    const marks = withReviewed(empty(), first);
    expect(readUnreviewedSessions(dir, marks, 10)).toEqual([]);
    expect(countUnreviewedSessions(dir, marks)).toBe(0);
  });

  it("sends only the new messages of a session that grew, with a few read ones as context", () => {
    session("chat-a", 10, T);
    const marks = withReviewed(empty(), readUnreviewedSessions(dir, empty(), 10));
    grow("chat-a", 10, 2, T + 60_000);
    const [t] = readUnreviewedSessions(dir, marks, 10);
    expect(t.pairs.map((m) => m.content)).toEqual(["chat-a message 10", "chat-a message 11"]);
    expect(t.earlier.map((m) => m.content)).toEqual(
      Array.from({ length: EARLIER_CONTEXT_MESSAGES }, (_, i) => `chat-a message ${10 - EARLIER_CONTEXT_MESSAGES + i}`),
    );
    const prompt = formatTranscriptForPrompt(t);
    expect(prompt.indexOf("save nothing from it")).toBeLessThan(prompt.indexOf("chat-a message 9"));
    expect(prompt.indexOf("New since the last dream")).toBeLessThan(prompt.indexOf("chat-a message 10"));
  });

  it("reads a session whole again when its read messages were rewritten", () => {
    session("chat-a", 4, T);
    const marks = withReviewed(empty(), readUnreviewedSessions(dir, empty(), 10));
    session("chat-a", 5, T + 60_000, 100); // same id, different messages
    const [t] = readUnreviewedSessions(dir, marks, 10);
    expect(t.earlier).toEqual([]);
    expect(t.pairs).toHaveLength(5);
  });

  it("counts a session unchanged since the last dream before marks existed as read", () => {
    session("chat-old", 4, T);
    session("chat-new", 4, T + 120_000);
    const marks = empty(T + 60_000);
    expect(readUnreviewedSessions(dir, marks, 10).map((t) => t.sessionId)).toEqual(["chat-new"]);
  });

  it("leaves sessions past the limit for the next dream instead of dropping them", () => {
    for (let i = 0; i < 5; i++) session(`chat-${i}`, 2, T + i * 1000);
    const first = readUnreviewedSessions(dir, empty(), 3);
    expect(first.map((t) => t.sessionId)).toEqual(["chat-4", "chat-3", "chat-2"]);
    const marks = withReviewed(empty(), first);
    // The two left over still count, so the schedule keeps the next dream due.
    expect(countUnreviewedSessions(dir, marks)).toBe(2);
    expect(readUnreviewedSessions(dir, marks, 3).map((t) => t.sessionId)).toEqual(["chat-1", "chat-0"]);
  });

  it("never counts or reads a dream's own session", () => {
    session("dream-1794542044255", 4, T);
    expect(countUnreviewedSessions(dir, empty())).toBe(0);
    expect(readUnreviewedSessions(dir, empty(), 10)).toEqual([]);
  });
});
