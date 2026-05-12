import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editTool } from "../src/tools/file-tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-edit-crlf-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("edit tool — line-ending tolerance", () => {
  it("matches LF old_string against a CRLF file (the Mario todo failure case)", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "first line\r\nsecond line\r\nthird line\r\n", "utf-8");

    const result = await editTool.execute({
      path,
      old_string: "first line\nsecond line",
      new_string: "first line\nNEW LINE",
    });

    expect(result.isError).toBeFalsy();
    const after = readFileSync(path, "utf-8");
    expect(after).toBe("first line\r\nNEW LINE\r\nthird line\r\n");
  });

  it("preserves CRLF style in new content when the file was CRLF", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "a\r\nb\r\nc\r\n", "utf-8");

    await editTool.execute({
      path,
      old_string: "a\nb\nc",
      new_string: "a\nX\nc",
    });

    const after = readFileSync(path, "utf-8");
    // New content's \n should have been promoted to \r\n
    expect(after).toBe("a\r\nX\r\nc\r\n");
    expect(after.includes("\nX\n")).toBe(false);
  });

  it("still works on a pure-LF file (no regression)", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "a\nb\nc\n", "utf-8");

    await editTool.execute({
      path,
      old_string: "a\nb",
      new_string: "a\nNEW",
    });

    expect(readFileSync(path, "utf-8")).toBe("a\nNEW\nc\n");
  });

  it("still reports old_string-not-found when the content genuinely isn't there", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "hello\r\nworld\r\n", "utf-8");

    const result = await editTool.execute({
      path,
      old_string: "totally\nabsent",
      new_string: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/old_string not found/);
  });

  it("still reports the non-unique error when old_string matches twice (CRLF file)", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "common\r\ncommon\r\n", "utf-8");

    const result = await editTool.execute({
      path,
      old_string: "common",
      new_string: "different",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/found .* times/);
  });

  it("does not promote new_string to CRLF when the file was LF (no silent style flip)", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "a\nb\nc\n", "utf-8");

    await editTool.execute({
      path,
      old_string: "a\nb",
      new_string: "a\nX\nY",
    });

    // The result must be pure LF — no \r\n introduced
    expect(readFileSync(path, "utf-8")).toBe("a\nX\nY\nc\n");
  });
});
