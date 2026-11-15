import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxStore, postToInbox, recentInbox } from "./index.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-inbox-recent-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("recentInbox", () => {
  it("returns what was told since a time, newest first, capped, without dismissed items or server-only fields", () => {
    const a = postToInbox({ kind: "notice", title: "A", body: "", needsYou: false, key: "k-a" })!;
    postToInbox({ kind: "notice", title: "B", body: "", needsYou: false });
    const c = postToInbox({ kind: "agent-message", title: "C", body: "", needsYou: false })!;
    inboxStore().dismiss(c.id);
    const items = recentInbox(0, 5);
    expect(items.map((i) => i.title).sort()).toEqual(["A", "B"]);
    expect(items[0]).not.toHaveProperty("key");
    expect(recentInbox(0, 1)).toHaveLength(1);
    expect(recentInbox(a.createdAt + 60_000, 5)).toEqual([]);
  });
});
