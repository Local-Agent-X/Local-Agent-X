import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { evaluateScript, screenshotAsBase64 } from "./page-ops.js";

describe("screenshotAsBase64 vision persistence", () => {
  it("persists the full PNG bytes and references it for view_image instead of discarding the pixels", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-shot-"));
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    try {
      // A distinctive buffer longer than the old 200-char base64 slice so we can
      // prove the WHOLE capture is kept, not a truncated fragment.
      const pixels = Buffer.from("PNGPIXELS".repeat(500), "utf8");
      const page = {
        screenshot: async () => pixels,
        title: async () => "Acme Dashboard",
        url: () => "https://acme.test/app",
      } as unknown as Page;

      const out = await screenshotAsBase64(page, "chromium");

      // Pre-fix behavior returned a truncated `[base64:…]` fragment and saved
      // nothing — both are the failure this asserts against.
      expect(out).not.toContain("[base64:");
      expect(out).toContain("view_image");

      const files = readdirSync(join(dataDir, "uploads")).filter((f) => f.endsWith(".png"));
      expect(files).toHaveLength(1);
      const saved = readFileSync(join(dataDir, "uploads", files[0]));
      // The full buffer round-tripped to disk, byte-for-byte.
      expect(saved.equals(pixels)).toBe(true);
      // The returned reference points at the exact file the model can open.
      expect(out).toContain(files[0]);
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = prev;
    }
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
