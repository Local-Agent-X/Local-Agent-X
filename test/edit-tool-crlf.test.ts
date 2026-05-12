import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editTool, writeTool } from "../src/tools/file-tools.js";

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

describe("write tool — line-ending preservation on overwrite", () => {
  it("preserves CRLF when overwriting an existing CRLF file with LF content", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "line1\r\nline2\r\nline3\r\n", "utf-8");

    await writeTool.execute({
      path,
      content: "new1\nnew2\nnew3\n",
    });

    expect(readFileSync(path, "utf-8")).toBe("new1\r\nnew2\r\nnew3\r\n");
  });

  it("preserves LF when overwriting an existing LF file", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "line1\nline2\n", "utf-8");

    await writeTool.execute({
      path,
      content: "new1\nnew2\n",
    });

    expect(readFileSync(path, "utf-8")).toBe("new1\nnew2\n");
  });

  it("writes LF for a brand-new file (no existing style to preserve)", async () => {
    const path = join(dir, "new.html");

    await writeTool.execute({
      path,
      content: "fresh1\nfresh2\n",
    });

    expect(readFileSync(path, "utf-8")).toBe("fresh1\nfresh2\n");
  });

  it("treats a file with already-CRLF content as CRLF (no double-promotion)", async () => {
    const path = join(dir, "f.html");
    writeFileSync(path, "a\r\nb\r\n", "utf-8");

    // Model passes content that already has \r\n in it
    await writeTool.execute({
      path,
      content: "x\r\ny\r\n",
    });

    // Should NOT become "x\r\r\ny\r\r\n" — the replace step is \r?\n → \r\n
    expect(readFileSync(path, "utf-8")).toBe("x\r\ny\r\n");
  });
});
