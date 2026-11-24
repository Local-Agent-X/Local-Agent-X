// Which of two copies of a session log holds more of the conversation. The
// same bytes are answered without parsing; anything else is decided by the
// rows, never by size.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionLogIsAhead } from "./session-log-ahead.js";

describe("sessionLogIsAhead", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-log-ahead-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const log = (updatedAt: number, msgs: string[]): string =>
    [JSON.stringify({ kind: "meta", id: "s", title: "t", createdAt: 1, updatedAt }),
      ...msgs.map((content, i) => JSON.stringify({ kind: "msg", id: `m${i}`, message: { role: "user", content }, createdAt: "2026-10-07T00:00:00Z" }))].join("\n") + "\n";
  const put = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it("is false for two copies with the same bytes", () => {
    const text = log(5, ["a", "b"]);
    expect(sessionLogIsAhead(put("remote.jsonl", text), put("local.jsonl", text))).toBe(false);
  });

  it("is false for the same bytes even when they are not a readable log", () => {
    expect(sessionLogIsAhead(put("remote.jsonl", "not json\n"), put("local.jsonl", "not json\n"))).toBe(false);
  });

  it("decides copies of the same size by their rows, not by the size", () => {
    const earlier = log(5, ["a", "b"]);
    const later = log(9, ["a", "b"]);
    expect(later.length).toBe(earlier.length);
    expect(sessionLogIsAhead(put("remote.jsonl", later), put("local.jsonl", earlier))).toBe(true);
    expect(sessionLogIsAhead(put("remote2.jsonl", earlier), put("local2.jsonl", later))).toBe(false);
  });

  it("puts the copy with more messages ahead, whichever is bigger", () => {
    const more = log(1, ["a", "b", "c"]);
    const fewerButBigger = log(1, ["a", "x".repeat(500)]);
    expect(sessionLogIsAhead(put("remote.jsonl", more), put("local.jsonl", fewerButBigger))).toBe(true);
    expect(sessionLogIsAhead(put("remote2.jsonl", fewerButBigger), put("local2.jsonl", more))).toBe(false);
  });

  it("treats a copy that cannot be read as holding nothing", () => {
    expect(sessionLogIsAhead(put("remote.jsonl", log(1, ["a"])), join(dir, "missing.jsonl"))).toBe(true);
    expect(sessionLogIsAhead(join(dir, "missing.jsonl"), put("local.jsonl", log(1, ["a"])))).toBe(false);
  });
});
