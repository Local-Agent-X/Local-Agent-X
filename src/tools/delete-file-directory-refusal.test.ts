// delete_file refuses a directory. The refusal used to end "delete the
// directory's contents one file at a time" and never named the shell route,
// so a model asked to clear a folder "in one go, not file by file" asserted
// that recursive deletion was blocked and asked the user which way to go
// (op-outcomes EXP-24 on gpt-5.6, 0/3). The refusal names `rm -r` under bash
// and the confirmation card first; file-by-file is the last resort.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteFileTool } from "./read-write-tools.js";

describe("delete_file on a directory", () => {
  it("refuses, names the recursive shell route and its confirmation, and leaves the folder intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-delete-dir-"));
    const dir = join(root, "build-cache");
    mkdirSync(join(dir, "chunks"), { recursive: true });
    writeFileSync(join(dir, "chunks", "a.js"), "");
    try {
      const r = await deleteFileTool.execute({ path: dir });
      expect(r.isError).toBe(true);
      const text = String(r.content);
      expect(text).toContain("Refusing to delete a directory");
      expect(text).toContain("rm -r");
      expect(text).toContain("bash");
      expect(text).toContain("confirmation");
      expect(text.indexOf("rm -r")).toBeLessThan(text.indexOf("one file at a time"));
      expect(text).toContain("app_delete");
      expect(r.metadata).toMatchObject({ isDirectory: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
