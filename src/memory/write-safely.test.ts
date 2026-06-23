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
import { writeMemorySafely, MemoryWriteBlocked, MAX_PROFILE_CHARS } from "./write-safely.js";

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

describe("writeMemorySafely profile bound (every writer, at the gate)", () => {
  it("does not strip profile lines under the cap — no lossy transform at the gate", () => {
    const target = join(tempDir, "USER.md");
    // Mix of non-bullet lines (which dedupeProfileMarkdown drops) and a bullet.
    writeMemorySafely({ content: "# About Me\nName: Alex\nRole: builder\n- Likes: pizza\n", source: "auto-extract", target });
    const out = readFileSync(target, "utf-8");
    expect(out).toContain("Name: Alex");
    expect(out).toContain("Role: builder");
    expect(out).toContain("- Likes: pizza");
  });

  it("blocks a profile write over the cap (surfaces, writes nothing)", () => {
    const target = join(tempDir, "USER.md");
    const huge = "# User Profile\n- bio: " + "word ".repeat(MAX_PROFILE_CHARS) + "\n";
    expect(() => writeMemorySafely({ content: huge, source: "tool", target })).toThrow(MemoryWriteBlocked);
    expect(existsSync(target)).toBe(false);
  });

  it("applies to IDENTITY.md and HEART.md too (all profile files)", () => {
    for (const name of ["IDENTITY.md", "HEART.md"]) {
      const target = join(tempDir, name);
      const huge = "# x\n- bio: " + "word ".repeat(MAX_PROFILE_CHARS) + "\n";
      expect(() => writeMemorySafely({ content: huge, source: "tool", target })).toThrow(MemoryWriteBlocked);
    }
  });

  it("does NOT cap a non-profile file (daily logs, saved notes)", () => {
    const target = join(tempDir, "notes.md");
    const big = "line\n".repeat(MAX_PROFILE_CHARS); // well over the profile cap
    expect(() => writeMemorySafely({ content: big, source: "tool", target })).not.toThrow();
    expect(existsSync(target)).toBe(true);
  });
});
