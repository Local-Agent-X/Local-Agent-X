import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { evaluateScript, screenshotAsBase64 } from "./page-ops.js";

describe("screenshotAsBase64 vision persistence", () => {
  async function withDataDir<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-shot-"));
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    try {
      return await fn(dataDir);
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = prev;
    }
  }

  it("returns an inline downscaled JPEG _image payload AND persists the full PNG", async () => {
    await withDataDir(async (dataDir) => {
      const sharp = (await import("sharp")).default;
      // Real 400×300 PNG so the inline encoder has actual pixels to downscale.
      const pixels = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 100, b: 50 } },
      }).png().toBuffer();
      const page = {
        screenshot: async () => pixels,
        title: async () => "Acme Dashboard",
        url: () => "https://acme.test/app",
      } as unknown as Page;

      const out = await screenshotAsBase64(page, "chromium");

      // Inline vision payload: JPEG, dimensions REDUCED vs the 400×300 original.
      expect(out.image).toBeDefined();
      expect(out.image!.mime).toBe("image/jpeg");
      const inline = Buffer.from(out.image!.b64, "base64");
      const meta = await sharp(inline).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(240); // 400 × 0.6
      expect(meta.width!).toBeLessThan(400);
      // Page context rides the question so the model keeps URL/title even
      // though audit-tool-call replaces the tool text for _image results.
      expect(out.image!.question).toContain("https://acme.test/app");

      // The FULL-RES PNG still lands on disk byte-for-byte (view_image +
      // media delivery re-read it), and the text names the exact file.
      const files = readdirSync(join(dataDir, "uploads")).filter((f) => f.endsWith(".png"));
      expect(files).toHaveLength(1);
      const saved = readFileSync(join(dataDir, "uploads", files[0]));
      expect(saved.equals(pixels)).toBe(true);
      expect(out.text).toContain(files[0]);
      expect(out.image!.path).toBe(join(dataDir, "uploads", files[0]));
    });
  });

  it("still persists the bytes and falls back to the view_image reference when inline encoding fails", async () => {
    await withDataDir(async (dataDir) => {
      // Not decodable as an image — sharp must fail, but the capture contract
      // (file on disk + path in the text) must hold, with the reason surfaced.
      const pixels = Buffer.from("PNGPIXELS".repeat(500), "utf8");
      const page = {
        screenshot: async () => pixels,
        title: async () => "Acme Dashboard",
        url: () => "https://acme.test/app",
      } as unknown as Page;

      const out = await screenshotAsBase64(page, "chromium");

      expect(out.image).toBeUndefined();
      expect(out.text).not.toContain("[base64:");
      expect(out.text).toContain("Inline preview unavailable");
      expect(out.text).toContain("view_image");

      const files = readdirSync(join(dataDir, "uploads")).filter((f) => f.endsWith(".png"));
      expect(files).toHaveLength(1);
      const saved = readFileSync(join(dataDir, "uploads", files[0]));
      expect(saved.equals(pixels)).toBe(true);
      expect(out.text).toContain(files[0]);
    });
  });

  it("throws on an empty buffer instead of faking a capture", async () => {
    const page = {
      screenshot: async () => Buffer.alloc(0),
      title: async () => "x",
      url: () => "about:blank",
    } as unknown as Page;
    await expect(screenshotAsBase64(page, "chromium")).rejects.toThrow(/empty buffer/);
  });
});

describe("evaluateScript timeout", () => {
  it("rejects a never-resolving script within the budget instead of hanging to the wedge", async () => {
    const page = { evaluate: () => new Promise(() => { /* never resolves */ }) } as unknown as Page;
    const start = Date.now();
    await expect(evaluateScript(page, "awaitsForever()", 100)).rejects.toThrow(/exceeded 100ms/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("returns the value for a normal script (happy path intact)", async () => {
    const page = { evaluate: async () => "Acme Corp" } as unknown as Page;
    expect(await evaluateScript(page, "document.title", 1_000)).toBe("Acme Corp");
  });
});
