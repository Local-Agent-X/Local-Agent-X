import { describe, it, expect } from "vitest";
import { imageIsTextBearing, detectMime } from "../src/tools/shared/image-binary-meta.js";
import { scanForSecrets } from "../src/security/secret-scanner.js";

// Regression: the bridge image-forward loop (bootstrap-bridges.ts) decoded raster
// image bytes as UTF-8 and ran scanForSecrets over them. Compressed binary noise
// matches credential/entropy patterns by chance → "secret-shaped value" → the
// screenshot was silently dropped (Telegram AND WhatsApp). The fix gates the text
// secret-scan behind imageIsTextBearing(): raster images are not text-scanned;
// SVG / renamed-text / unknown payloads still are.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe("image-forward secret-scan gating", () => {
  it("a real PNG whose bytes contain a secret-shaped run is NOT text-scanned (the bug)", () => {
    // Embed a classic AWS example key so the OLD code path would have blocked it.
    const payload = Buffer.concat([PNG_MAGIC, Buffer.from(" AKIAIOSFODNN7EXAMPLE binary\x00\x01\x02noise")]);
    // Proves the false-positive was real: scanning the bytes as text flags it...
    expect(scanForSecrets(payload.toString("utf-8")).clean).toBe(false);
    // ...but it's genuine raster, so the fix skips the text scan → no block.
    expect(detectMime(payload)).toBe("image/png");
    expect(imageIsTextBearing(payload)).toBe(false);
  });

  it("a JPEG is treated as raster (not text-scanned)", () => {
    const payload = Buffer.concat([JPEG_MAGIC, Buffer.from("\x10\x20sk-secretshapednoise\x00")]);
    expect(imageIsTextBearing(payload)).toBe(false);
  });

  it("an SVG carrying a token IS text-bearing → still scanned/blockable", () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!-- AKIAIOSFODNN7EXAMPLE --></svg>`);
    expect(detectMime(svg)).toBe("image/svg+xml");
    expect(imageIsTextBearing(svg)).toBe(true);
    expect(scanForSecrets(svg.toString("utf-8")).clean).toBe(false); // would block
  });

  it("an unrecognized payload (renamed text file) is text-bearing → still scanned", () => {
    const renamedText = Buffer.from("not really an image — AKIAIOSFODNN7EXAMPLE inside a .png");
    expect(detectMime(renamedText)).toBeNull();
    expect(imageIsTextBearing(renamedText)).toBe(true);
  });
});
