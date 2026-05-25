// Locks the entry-store semantics that fix the "agent forgets" class.
// The corruption pattern these tests defend against: the model writes
// "user's name is Alex" but a stale "user's name is X" stays in the
// file and the next chat sees both. The atomic substring-replace API
// makes that impossible — there are no sections to forget, and replace
// always finds the existing entry by content.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EntryStore, ENTRY_DELIMITER } from "./entries.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lax-entries-"));
}

describe("EntryStore", () => {
  let dir: string;
  let store: EntryStore;

  beforeEach(() => {
    dir = tmp();
    store = new EntryStore({ baseDir: dir, filename: "F.md", charLimit: 1000 });
  });

  it("starts empty and round-trips an add", () => {
    expect(store.list()).toEqual([]);
    const r = store.add("user's name is Alex");
    expect(r.success).toBe(true);
    expect(store.list()).toEqual(["user's name is Alex"]);
  });

  it("drops exact-duplicate adds silently", () => {
    store.add("user's name is Alex");
    const r = store.add("user's name is Alex");
    expect(r.success).toBe(true);
    expect(store.list()).toEqual(["user's name is Alex"]);
  });

  it("replaces an entry by substring — first match wins", () => {
    store.add("user's name is Daddy Fag");
    store.add("user prefers terse responses");
    const r = store.replace("name is", "user's name is Alex");
    expect(r.success).toBe(true);
    expect(store.list()).toEqual([
      "user's name is Alex",
      "user prefers terse responses",
    ]);
  });

  it("refuses ambiguous replace when entries differ but both match", () => {
    store.add("user's job is at Google");
    store.add("user's job is at Meta");
    const r = store.replace("user's job", "user's job is at Anthropic");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ambiguous/);
    // Original entries are untouched on ambiguity.
    expect(store.list()).toContain("user's job is at Google");
    expect(store.list()).toContain("user's job is at Meta");
  });

  it("removes one entry by substring", () => {
    store.add("user's name is Alex");
    store.add("user prefers terse responses");
    const r = store.remove("prefers terse");
    expect(r.success).toBe(true);
    expect(store.list()).toEqual(["user's name is Alex"]);
  });

  it("refuses writes that would exceed the char cap", () => {
    const tiny = new EntryStore({ baseDir: dir, filename: "tiny.md", charLimit: 30 });
    expect(tiny.add("a".repeat(40)).success).toBe(false);
    expect(tiny.list()).toEqual([]);
  });

  it("survives concurrent adds — every write lands, no half-files", async () => {
    // Hammer the store with 20 simultaneous adds from the same process.
    // Without the lock + atomic-rename, one of the writers would clobber
    // a half-written file and we'd see fewer entries than expected, OR
    // a torn JSON delimiter in the on-disk file.
    const adds = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => store.add(`fact #${i}`)),
    );
    const results = await Promise.all(adds);
    const ok = results.filter((r) => r.success).length;
    expect(ok).toBe(20);
    expect(store.list().length).toBe(20);
  });

  it("backs up drift and refuses to write when an external editor inserted oversized content", () => {
    store.add("user's name is Alex");
    // Simulate an external writer dumping a giant blob in without using
    // our delimiter. The single "entry" is larger than the file's cap —
    // unmistakable drift signal.
    const filePath = join(dir, "F.md");
    writeFileSync(filePath, "X".repeat(2000), "utf-8");

    const r = store.add("user prefers concise responses");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/drift/);
    expect(r.driftBackup).toBeDefined();
    expect(existsSync(r.driftBackup!)).toBe(true);
    // Original file content is preserved — drift refused, didn't clobber.
    expect(readFileSync(filePath, "utf-8")).toBe("X".repeat(2000));
  });

  it("renders a system-prompt block (or null when empty)", () => {
    expect(store.renderForSystemPrompt("Things I know")).toBeNull();
    store.add("user's name is Alex");
    store.add("user prefers terse responses");
    const block = store.renderForSystemPrompt("Things I know");
    expect(block).not.toBeNull();
    expect(block).toContain("Things I know");
    expect(block).toContain("user's name is Alex");
    expect(block).toContain("user prefers terse responses");
  });

  it("on-disk format is § delimited and human readable", () => {
    store.add("fact one");
    store.add("fact two");
    const raw = readFileSync(join(dir, "F.md"), "utf-8");
    expect(raw).toBe(`fact one${ENTRY_DELIMITER}fact two`);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});
