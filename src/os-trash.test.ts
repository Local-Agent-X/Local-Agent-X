// The Windows Recycle Bin lookup that lets a delete verify the bin kept what
// it was given: every `$I` sidecar names the original path, the `$R` beside it
// holds the bytes. Built against a fake bin root so nothing here reads the
// developer's real bin.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInWindowsBin, parseRecycleSidecar } from "./os-trash.js";

const root = mkdtempSync(join(tmpdir(), "lax-fake-bin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A version-2 `$I` sidecar as Windows 10+ writes it. */
function sidecarV2(original: string, deletedAt: number): Buffer {
  const path = Buffer.from(`${original}\0`, "utf16le");
  const buf = Buffer.alloc(28 + path.length);
  buf.writeBigInt64LE(2n, 0);
  buf.writeBigInt64LE(1234n, 8);
  buf.writeBigUInt64LE(BigInt(deletedAt), 16);
  buf.writeInt32LE(path.length / 2, 24);
  path.copy(buf, 28);
  return buf;
}

function sidecarV1(original: string): Buffer {
  const buf = Buffer.alloc(24 + 520);
  buf.writeBigInt64LE(1n, 0);
  Buffer.from(`${original}\0`, "utf16le").copy(buf, 24);
  return buf;
}

function binItem(sid: string, id: string, ext: string, original: string, deletedAt: number, body = "bytes"): string {
  const dir = join(root, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `$I${id}${ext}`), sidecarV2(original, deletedAt));
  const r = join(dir, `$R${id}${ext}`);
  writeFileSync(r, body);
  return r;
}

describe("parseRecycleSidecar", () => {
  it("reads the original path and deletion time from a version-2 sidecar", () => {
    expect(parseRecycleSidecar(sidecarV2("C:\\Users\\p\\notes.md", 133_000_000_000_000_000)))
      .toEqual({ original: "C:\\Users\\p\\notes.md", deletedAt: 133_000_000_000_000_000 });
  });

  it("reads the fixed-width path of a version-1 sidecar", () => {
    expect(parseRecycleSidecar(sidecarV1("D:\\old.txt"))?.original).toBe("D:\\old.txt");
  });

  it("rejects a truncated or unknown-version buffer instead of throwing", () => {
    expect(parseRecycleSidecar(Buffer.alloc(10))).toBeNull();
    const bad = sidecarV2("C:\\x.txt", 1);
    bad.writeBigInt64LE(7n, 0);
    expect(parseRecycleSidecar(bad)).toBeNull();
    const short = sidecarV2("C:\\x.txt", 1).subarray(0, 30);
    expect(parseRecycleSidecar(short)).toBeNull();
  });
});

describe("findInWindowsBin", () => {
  it("matches the original path case-insensitively, skips other extensions, and prefers the newest deletion", () => {
    binItem("S-1-5-21-1", "AAAAAA", ".md", "C:\\work\\report.md", 100);
    const newest = binItem("S-1-5-21-1", "BBBBBB", ".md", "c:\\work\\REPORT.md", 200);
    binItem("S-1-5-21-1", "CCCCCC", ".txt", "C:\\work\\report.md", 300); // sidecar ext differs — never the same item
    expect(findInWindowsBin("C:\\work\\report.md", root)).toBe(newest);
  });

  it("reports null for a path no sidecar names, and for a bin root that cannot be read", () => {
    expect(findInWindowsBin("C:\\work\\never-deleted.md", root)).toBeNull();
    expect(findInWindowsBin("C:\\work\\report.md", join(root, "missing"))).toBeNull();
  });

  it("ignores a sidecar whose $R file is already gone", () => {
    const r = binItem("S-1-5-21-1", "DDDDDD", ".csv", "C:\\work\\gone.csv", 100);
    rmSync(r);
    expect(findInWindowsBin("C:\\work\\gone.csv", root)).toBeNull();
  });
});
