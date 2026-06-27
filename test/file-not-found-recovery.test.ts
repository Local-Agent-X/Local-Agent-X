/**
 * Regression guard: read / edit_lines / multi_edit now return sibling-path
 * suggestions on a missing file, same as edit already did. A model that typos
 * a path used to get a bare "File not found" dead-end on those tools and would
 * re-emit the same wrong path. fileNotFoundError is the single owner so the
 * format can't drift between the four call sites.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileNotFoundError } from "../src/tools/edit-recovery.js";

describe("fileNotFoundError — sibling-path recovery", () => {
  it("suggests the near-name sibling when the model typos the filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-fnf-"));
    try {
      writeFileSync(join(dir, "notes.md"), "hi", "utf-8");
      const res = fileNotFoundError(join(dir, "note.md")); // typo: note vs notes
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/File not found/);
      expect(String(res.metadata?.recovery)).toContain("notes.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the recovery line when no similar sibling exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-fnf-"));
    try {
      const res = fileNotFoundError(join(dir, "zzz-nothing-alike.bin"));
      expect(res.isError).toBe(true);
      expect(res.metadata?.recovery).toBeUndefined();
      expect(res.metadata?.path).toBe(join(dir, "zzz-nothing-alike.bin"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
