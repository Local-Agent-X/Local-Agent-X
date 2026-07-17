import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAN_CREATE_FILE_SYMLINK } from "../../symlink-capabilities.test-helper.js";
import { acquireImages } from "./image-acquire.js";

// 1×1 PNG (transparent) — hoisted so the web-egress mock factory (which runs
// during import resolution, before this module's body) can serve it.
const hoisted = vi.hoisted(() => ({
  png: Buffer.from(
    "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
    "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
    "hex",
  ),
}));
const PNG_1x1 = hoisted.png;

// Deterministic network for the fallback-ladder tests; every other URL keeps
// the REAL canonicalFetch so the SSRF-gate test still exercises the gate.
vi.mock("../web-egress.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../web-egress.js")>();
  return {
    ...real,
    canonicalFetch: async (url: string, opts: never) => {
      if (url.includes("mock-origin-dead")) throw new Error("HTTP 522: origin stalled");
      if (url.includes("mock-fallback-ok")) return new Response(new Uint8Array(hoisted.png));
      return real.canonicalFetch(url, opts);
    },
  };
});

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
  it("returns an empty outcome for empty input", async () => {
    const out = await acquireImages([]);
    expect(out).toEqual({ images: [], notes: [] });
  });

  it("reads a local PNG by absolute path (under the workspace)", async () => {
    const p = join(workspaceRoot, "tiny.png");
    writeFileSync(p, PNG_1x1);
    const [img] = (await acquireImages([{ source: p }], { workspaceRoot })).images;
    expect(img.mimeType).toBe("image/png");
    expect(img.width).toBe(1);
    expect(img.height).toBe(1);
    expect(img.buffer.length).toBe(PNG_1x1.length);
  });

  it("reads a local JPEG and parses dimensions", async () => {
    const p = join(workspaceRoot, "tiny.jpg");
    writeFileSync(p, JPEG_2x3);
    const [img] = (await acquireImages([{ source: p }], { workspaceRoot })).images;
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.width).toBe(2);
    expect(img.height).toBe(3);
  });

  // The closed bypass: an ABSOLUTE path OUTSIDE the workspace must be refused,
  // so an agent can't embed an arbitrary on-disk image into a generated
  // document to side-step the file-access boundary. (Previously the absolute
  // branch returned the path unchecked.)
  it("blocks an absolute path outside the workspace", async () => {
    const outside = join(tmpdir(), "img-acq-outside.png");
    writeFileSync(outside, PNG_1x1);
    try {
      await expect(
        acquireImages([{ source: outside }], { workspaceRoot }),
      ).rejects.toThrow(/under the workspace|traversal blocked/i);
    } finally {
      try { rmSync(outside, { force: true }); } catch {}
    }
  });

  // R4-21: a workspace file whose NAME is under the workspace but whose REALPATH
  // escapes it (logo.png → /outside/img.png) must be blocked. The lexical
  // resolve()+startsWith left this hole open; realpath containment closes it —
  // even though the target IS a valid image (so the mime gate alone wouldn't
  // catch it), it lives outside the workspace and must not round-trip.
  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("blocks a workspace symlink that escapes to an outside image (realpath containment)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "img-acq-escape-"));
    const outside = join(outsideDir, "real.png");
    writeFileSync(outside, PNG_1x1);
    const link = join(workspaceRoot, "logo.png");
    symlinkSync(outside, link);
    try {
      await expect(
        acquireImages([{ source: "logo.png" }], { workspaceRoot }),
      ).rejects.toThrow(/under the workspace|traversal blocked/i);
    } finally {
      try { rmSync(link, { force: true }); } catch {}
      try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("resolves relative paths under workspaceRoot", async () => {
    const dir = join(workspaceRoot, "subdir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rel.png"), PNG_1x1);
    const [img] = (await acquireImages(
      [{ source: "subdir/rel.png" }],
      { workspaceRoot },
    )).images;
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
    await expect(acquireImages([{ source: p }], { workspaceRoot })).rejects.toThrow(/unsupported or undetectable type/);
  });

  it("throws when bytes exceed maxBytes", async () => {
    const p = join(workspaceRoot, "tiny2.png");
    writeFileSync(p, PNG_1x1);
    await expect(
      acquireImages([{ source: p }], { maxBytes: 8, workspaceRoot }),
    ).rejects.toThrow(/exceeds size cap/);
  });

  it("throws on private-IP URL via SSRF gate", async () => {
    // canonicalFetch's per-hop literal-IP gate blocks RFC1918 ranges (loopback
    // self-calls stay allowed via the configured-port self-call recognition).
    await expect(
      acquireImages([{ source: "http://10.0.0.1/img.png" }]),
    ).rejects.toThrow(/blocked|Blocked/);
  });

  it("forwards source and caption fields", async () => {
    const p = join(workspaceRoot, "tiny3.png");
    writeFileSync(p, PNG_1x1);
    const [img] = (await acquireImages([{ source: p, caption: "hello" }], { workspaceRoot })).images;
    expect(img.source).toBe(p);
    expect(img.caption).toBe("hello");
  });

  // ── Reliability ladder ──

  it("rung 1: falls back to fallback_source when the origin fails, with a loud note", async () => {
    const r = await acquireImages([{
      source: "https://example.com/mock-origin-dead.png",
      fallback_source: "https://example.com/mock-fallback-ok.png",
    }]);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].source).toBe("https://example.com/mock-fallback-ok.png");
    expect(r.notes[0]).toMatch(/used fallback URL for .*mock-origin-dead/);
  });

  it("rung 2: drops a dead URL with a note while other images still embed", async () => {
    const p = join(workspaceRoot, "ok-beside-dead.png");
    writeFileSync(p, PNG_1x1);
    const r = await acquireImages(
      [{ source: p }, { source: "https://example.com/mock-origin-dead.png" }],
      { workspaceRoot },
    );
    expect(r.images).toHaveLength(1);
    expect(r.images[0].source).toBe(p);
    expect(r.notes[0]).toMatch(/dropped image .*mock-origin-dead/);
  });

  it("rung 3: throws AllImagesFailedError when every source fails", async () => {
    await expect(acquireImages([
      { source: "https://example.com/mock-origin-dead-1.png" },
      { source: "https://example.com/mock-origin-dead-2.png", fallback_source: "https://example.com/mock-origin-dead-3.png" },
    ])).rejects.toThrow(/All 2 image source\(s\) failed/);
  });

  it("local-path failures still throw immediately (deterministic caller error, not a flaky host)", async () => {
    const p = join(workspaceRoot, "good-local.png");
    writeFileSync(p, PNG_1x1);
    await expect(
      acquireImages([{ source: p }, { source: "no-such-file.png" }], { workspaceRoot }),
    ).rejects.toThrow(/Could not read image/);
  });
});
