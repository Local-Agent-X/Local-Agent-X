import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireImages } from "./image-acquire.js";

// 1×1 PNG (transparent)
const PNG_1x1 = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
  "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

// Minimal JPEG with SOF0 → 2×3 dims
const JPEG_2x3 = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xc0, // SOF0
  0x00, 0x11, // segLen
  0x08,       // precision
  0x00, 0x03, // height = 3
  0x00, 0x02, // width = 2
  0x03,       // components
  0x01, 0x22, 0x00,
  0x02, 0x11, 0x01,
  0x03, 0x11, 0x01,
  0xff, 0xd9, // EOI
]);

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "img-acq-"));
});

afterAll(() => {
  try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
});

describe("acquireImages", () => {
  it("returns [] for empty input", async () => {
    const out = await acquireImages([]);
    expect(out).toEqual([]);
  });

  it("reads a local PNG by absolute path", async () => {
    const p = join(workspaceRoot, "tiny.png");
    writeFileSync(p, PNG_1x1);
    const [img] = await acquireImages([{ source: p }]);
    expect(img.mimeType).toBe("image/png");
    expect(img.width).toBe(1);
    expect(img.height).toBe(1);
    expect(img.buffer.length).toBe(PNG_1x1.length);
  });

  it("reads a local JPEG and parses dimensions", async () => {
    const p = join(workspaceRoot, "tiny.jpg");
    writeFileSync(p, JPEG_2x3);
    const [img] = await acquireImages([{ source: p }]);
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.width).toBe(2);
    expect(img.height).toBe(3);
  });

  it("resolves relative paths under workspaceRoot", async () => {
    const dir = join(workspaceRoot, "subdir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rel.png"), PNG_1x1);
    const [img] = await acquireImages(
      [{ source: "subdir/rel.png" }],
      { workspaceRoot },
    );
    expect(img.mimeType).toBe("image/png");
  });

  it("blocks path traversal", async () => {
    await expect(
      acquireImages([{ source: "../escape.png" }], { workspaceRoot }),
    ).rejects.toThrow(/traversal blocked/i);
  });

  it("throws on bad MIME", async () => {
    const p = join(workspaceRoot, "not-image.txt");
    writeFileSync(p, "hello world");
    await expect(acquireImages([{ source: p }])).rejects.toThrow(/unsupported or undetectable type/);
  });

  it("throws when bytes exceed maxBytes", async () => {
    const p = join(workspaceRoot, "tiny2.png");
    writeFileSync(p, PNG_1x1);
    await expect(
      acquireImages([{ source: p }], { maxBytes: 8 }),
    ).rejects.toThrow(/exceeds size cap/);
  });

  it("throws on private-IP URL via SSRF gate", async () => {
    // dnsPinCheck allows localhost intentionally, but blocks RFC1918 ranges.
    await expect(
      acquireImages([{ source: "http://10.0.0.1/img.png" }]),
    ).rejects.toThrow(/blocked|Blocked/);
  });

  it("forwards source and caption fields", async () => {
    const p = join(workspaceRoot, "tiny3.png");
    writeFileSync(p, PNG_1x1);
    const [img] = await acquireImages([{ source: p, caption: "hello" }]);
    expect(img.source).toBe(p);
    expect(img.caption).toBe("hello");
  });
});
