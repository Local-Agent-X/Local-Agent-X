/**
 * Overwrite history: every content-changing overwrite through the memory
 * write gate snapshots the previous version into a sibling .history/ dir.
 * That dir is the undo layer for ~/.lax/memory — atomic writes protect
 * against crashes, snapshots protect against bad content.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemorySafely } from "./write-safely.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-history-"));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function historyFiles(): string[] {
  const dir = join(tempDir, ".history");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("writeMemorySafely overwrite history", () => {
  it("snapshots the previous version before overwriting", () => {
    const target = join(tempDir, "USER.md");
    writeFileSync(target, "# About Me\nName: Alex\n", "utf-8");

    writeMemorySafely({ content: "# About Me\nName: Alex\nRole: builder\n", source: "tool", target });

    const snaps = historyFiles();
    expect(snaps).toHaveLength(1);
    expect(readFileSync(join(tempDir, ".history", snaps[0]), "utf-8")).toBe("# About Me\nName: Alex\n");
    expect(readFileSync(target, "utf-8")).toContain("Role: builder");
  });

  it("does not snapshot a brand-new file or an unchanged write", () => {
    const target = join(tempDir, "HEART.md");
    writeMemorySafely({ content: "calm and direct\n", source: "tool", target });
    expect(historyFiles()).toHaveLength(0);

    writeMemorySafely({ content: "calm and direct\n", source: "tool", target });
    expect(historyFiles()).toHaveLength(0);
  });

  it("does not snapshot on append", () => {
    const target = join(tempDir, "2026-06-10.md");
    writeFileSync(target, "first line\n", "utf-8");
    writeMemorySafely({ content: "second line\n", source: "tool", target, mode: "append" });
    expect(historyFiles()).toHaveLength(0);
    expect(readFileSync(target, "utf-8")).toContain("second line");
  });

  it("prunes history to the retention cap", () => {
    const target = join(tempDir, "USER.md");
    writeFileSync(target, "version 0\n", "utf-8");
    for (let i = 1; i <= 25; i++) {
      writeMemorySafely({ content: `version ${i}\n`, source: "tool", target });
    }
    expect(historyFiles().length).toBeLessThanOrEqual(20);
  });
});
