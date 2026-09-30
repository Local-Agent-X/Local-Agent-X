import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countSessionMessages } from "./index-sync.js";
import { writeSessionLog } from "./session-message-log.js";
import type { Session } from "../types.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function session(id: string, turns: number): Session {
  const messages: Session["messages"] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({ role: "assistant", content: `answer ${i}` });
  }
  return { id, title: "t", createdAt: 1, updatedAt: 2, messages } as Session;
}

describe("countSessionMessages", () => {
  it("counts msg rows in a jsonl log, so a grown session is seen as grown", () => {
    root = mkdtempSync(join(tmpdir(), "lax-count-"));
    writeSessionLog(root, session("s1", 3));
    expect(countSessionMessages(join(root, "s1.jsonl"))).toBe(6);
    writeSessionLog(root, session("s1", 5));
    expect(countSessionMessages(join(root, "s1.jsonl"))).toBe(10);
  });

  it("still reads the legacy whole-file json shape, and returns 0 for a missing or torn file", () => {
    root = mkdtempSync(join(tmpdir(), "lax-count-"));
    writeFileSync(join(root, "old.json"), JSON.stringify(session("old", 2)));
    expect(countSessionMessages(join(root, "old.json"))).toBe(4);
    writeFileSync(join(root, "torn.jsonl"), '{"kind":"meta","id":"torn"}\n{"kind":"msg","mess');
    expect(countSessionMessages(join(root, "torn.jsonl"))).toBe(0);
    expect(countSessionMessages(join(root, "missing.jsonl"))).toBe(0);
  });
});
