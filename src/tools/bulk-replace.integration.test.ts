import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bulkReplaceTool } from "./edit-tools.js";

// End-to-end through the REAL bulk_replace tool: multi-file find/replace with
// verifiable per-file counts — the tool-native form of `sed -i` over a tree.
// Absolute temp paths, no model, no mocks.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-bulk-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "alpha beta alpha\n");
  writeFileSync(join(dir, "sub", "b.txt"), "alpha\n");
  writeFileSync(join(dir, "c.md"), "gamma only\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bulkReplaceTool", () => {
  it("replaces every occurrence across matching files and reports per-file counts", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("Replaced 3 occurrence(s) across 2 file(s)");
    expect(String(r.content)).toContain("a.txt: 2");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("omega beta omega\n");
    expect(readFileSync(join(dir, "sub", "b.txt"), "utf-8")).toBe("omega\n");
    expect(readFileSync(join(dir, "c.md"), "utf-8")).toBe("gamma only\n");
  });

  it("dry_run reports counts without writing", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega", dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("Would replace 3 occurrence(s)");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha beta alpha\n");
  });

  it("honors the glob filter", async () => {
    writeFileSync(join(dir, "d.md"), "alpha\n");
    const r = await bulkReplaceTool.execute({ path: dir, glob: "**/*.md", old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("across 1 file(s)");
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha beta alpha\n"); // .txt untouched
    expect(readFileSync(join(dir, "d.md"), "utf-8")).toBe("omega\n");
  });

  it("REFUSES when nothing matches — 0 matches is an error, not silent success", async () => {
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "nope-not-here", new_string: "x" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("not found");
  });

  it("skips sensitive-pattern files inside the tree and says so", async () => {
    writeFileSync(join(dir, ".env"), "alpha=1\n");
    const r = await bulkReplaceTool.execute({ path: dir, old_string: "alpha", new_string: "omega" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, ".env"), "utf-8")).toBe("alpha=1\n");
    expect(String(r.metadata?.recovery ?? "")).toContain(".env");
  });

  it("matches CRLF files when old_string was quoted with LF", async () => {
    writeFileSync(join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\n");
    const r = await bulkReplaceTool.execute({ path: dir, glob: "win.txt", old_string: "one\ntwo", new_string: "uno\ndos" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "win.txt"), "utf-8")).toBe("uno\r\ndos\r\nthree\r\n");
  });

  it("accepts a single FILE as the path", async () => {
    const r = await bulkReplaceTool.execute({ path: join(dir, "a.txt"), old_string: "beta", new_string: "delta" });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha delta alpha\n");
  });
});
