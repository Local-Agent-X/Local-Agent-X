import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Persistence lock for the persona stores that had no coverage before their
// migration onto util/json-store: the storage filename and the on-disk byte
// format (pretty JSON envelope) must not drift, or existing ~/.lax state is
// silently orphaned. Both modules bind STORE_FILE = join(getLaxDir(), …) at
// import, so isolate LAX_DATA_DIR BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "persona-store-persist-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { loadStore, saveStore } = await import("./narrative-memory-store.js");
const { LanguageMirror } = await import("./language-mirror.js");

describe("narrative-memory-store persistence", () => {
  it("round-trips narratives.json in the exact legacy byte format", () => {
    const narrative = {
      id: "abc123",
      title: "Test arc",
      summary: "A test narrative",
      chapters: [{ text: "ch1", timestamp: 1, emotions: ["happy"] }],
      characters: ["Peter"],
      emotions: ["happy"],
      tags: ["test"],
      startDate: "2026-07-11",
      ongoing: true,
    };
    saveStore({ narratives: [narrative] });

    // Same filename, same envelope, same pretty-printed stringify as the
    // module's original private copy wrote.
    const raw = readFileSync(join(tmp, "narratives.json"), "utf-8");
    expect(raw).toBe(JSON.stringify({ narratives: [narrative] }, null, 2));

    expect(loadStore().narratives).toEqual([narrative]);
  });
});

describe("language-mirror persistence", () => {
  it("persists style tracking to language-style.json and reloads it", () => {
    LanguageMirror.reset();
    LanguageMirror.getInstance().recordUserStyle("yo lol this is hella casual lol lol");

    const onDisk = JSON.parse(readFileSync(join(tmp, "language-style.json"), "utf-8"));
    expect(onDisk.messageCount).toBe(1);
    expect(onDisk.slangCounts.lol).toBe(3);

    // A fresh singleton must load the persisted counts back.
    LanguageMirror.reset();
    const profile = LanguageMirror.getInstance().getStyleProfile();
    expect(profile.sampleSize).toBe(1);
    expect(profile.slangTerms).toContain("lol");
    LanguageMirror.reset();
  });
});
