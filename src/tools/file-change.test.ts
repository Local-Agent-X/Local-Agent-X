import { describe, it, expect } from "vitest";
import { fileChangeOf } from "./file-change.js";

describe("fileChangeOf", () => {
  it("counts the lines an edit added and removed, with the hunk around them", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = before.replace("d\n", "D\nD2\n");
    const change = fileChangeOf("/w/x.ts", before, after);
    expect(change).toMatchObject({ path: "/w/x.ts", created: false, added: 2, removed: 1 });
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks![0]!.oldStart).toBe(1);
    expect(change.hunks![0]!.lines).toEqual([" a", " b", " c", "-d", "+D", "+D2", " e", " f", " g"]);
  });

  it("marks a new file created, every line added", () => {
    expect(fileChangeOf("/w/new.md", null, "one\ntwo\n")).toMatchObject({ created: true, added: 2, removed: 0 });
  });

  it("does not count a file's CRLF endings as the change", () => {
    const change = fileChangeOf("/w/x.txt", "a\r\nb\r\n", "a\r\nB\r\n");
    expect(change).toMatchObject({ added: 1, removed: 1 });
    expect(change.hunks![0]!.lines).toEqual([" a", "-b", "+B"]);
  });

  it("never carries a credential file's contents", () => {
    const change = fileChangeOf("/w/.env", "KEY=old\n", "KEY=new\n");
    expect(change).toMatchObject({ added: 1, removed: 1 });
    expect(change.hunks).toBeUndefined();
  });

  it("cuts a huge diff and says so", () => {
    const after = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const change = fileChangeOf("/w/big.txt", null, after);
    expect(change.added).toBe(1000);
    expect(change.truncated).toBe(true);
    expect(change.hunks!.flatMap((h) => h.lines)).toHaveLength(400);
  });
});
