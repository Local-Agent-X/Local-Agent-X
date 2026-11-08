/**
 * A trashed file is known to the user by the name it had, never by the name
 * the trash gave it (2026-11-08: "delete agentxos-4c218-….json" could not
 * match the Recycle Bin's `$R6V7H9Q.json`, and the delete was refused).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const lax = mkdtempSync(join(tmpdir(), "lax-trashed-target-"));
process.env.LAX_DATA_DIR = lax;

const { trashedTarget } = await import("./trashed-target.js");
const { appendTrashJournal } = await import("../trash-journal.js");

/** A version-2 `$I` sidecar as Windows 10+ writes it (os-trash.test.ts). */
function sidecarV2(original: string): Buffer {
  const path = Buffer.from(`${original}\0`, "utf16le");
  const buf = Buffer.alloc(28 + path.length);
  buf.writeBigInt64LE(2n, 0);
  buf.writeBigInt64LE(2362n, 8);
  buf.writeBigUInt64LE(133_000_000_000_000_000n, 16);
  buf.writeInt32LE(path.length / 2, 24);
  path.copy(buf, 28);
  return buf;
}

const root = mkdtempSync(join(tmpdir(), "lax-trashed-target-files-"));
const downloads = join(root, "Documents", "Local Agent X", "workspace", "downloads");
const KEY = join(downloads, "agentxos-4c218-9d8a76b91793.json");

describe("trashedTarget", () => {
  it("a file the journal put in a trash is known by its original path", () => {
    const dest = join(lax, "trash", "2026-11-08", "agentxos-4c218-9d8a76b91793.json");
    appendTrashJournal({ original: KEY, tier: "lax", dest, kind: "file" });
    expect(trashedTarget(dest)).toEqual({ original: KEY });
    expect(trashedTarget(dest.replace(/\\/g, "/")), "the spelling the shell used").toEqual({ original: KEY });
  });

  it("a Recycle Bin item is known by the path its `$I` sidecar records — the `$R` file or the sidecar itself", () => {
    const bin = join(root, "$Recycle.Bin", "S-1-5-21-2354323282-2118116252-846633789-1001");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "$I6V7H9Q.json"), sidecarV2(KEY));
    writeFileSync(join(bin, "$R6V7H9Q.json"), "{}");
    expect(trashedTarget(join(bin, "$R6V7H9Q.json"))).toEqual({ original: KEY });
    expect(trashedTarget(join(bin, "$I6V7H9Q.json"))).toEqual({ original: KEY });
  });

  it("a file in LAX's trash that nothing journalled is still a trashed file, with no name to offer", () => {
    expect(trashedTarget(join(lax, "trash", "2026-11-01", "stray.txt"))).toEqual({ original: null });
    expect(trashedTarget(join(lax, "trash", "task", "s1", "scratch.md"))).toEqual({ original: null });
  });

  it("anything else is not in a trash", () => {
    expect(trashedTarget(KEY)).toBeNull();
    expect(trashedTarget(join(root, "$Recycle.Bin", "notes.md")), "a `$Recycle.Bin` file that is not an item").toBeNull();
    expect(trashedTarget(join(root, "$RANDOM.json")), "a `$R` name outside the bin").toBeNull();
    expect(trashedTarget(join(lax, "trash-journal.jsonl")), "the journal beside the trash, not in it").toBeNull();
  });
});
