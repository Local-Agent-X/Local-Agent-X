// R4-20: view_image must gate on the file's MAGIC BYTES, not its extension. A
// non-image file renamed `.png` (an exported secret, a sqlite db, a json blob)
// previously sailed past the extension-only check and base64-shipped to the
// vision provider. The magic-byte detectMime gate now rejects it before egress.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getLaxDir } from "../lax-data-dir.js";
import { viewImageTool, resolveMediaPath } from "./vision-tools.js";

// 1×1 transparent PNG — real image bytes.
const PNG_1x1 = Buffer.from(
  "89504E470D0A1A0A0000000D4948445200000001000000010806000000" +
  "1F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

const dirs = new Set<string>();
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.clear();
});

describe("view_image magic-byte content gate", () => {
  it("rejects a non-image file renamed .png (no _image payload, not base64-shipped)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-viewimg-"));
    dirs.add(dir);
    // Looks like a secret export; extension lies about its type.
    const fake = join(dir, "token.png");
    writeFileSync(fake, "AKIA0000000000000000\napi_key=supersecretvalue\n");

    const res: any = await viewImageTool.execute({ path: fake });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Not an image|Refusing/i);
    // The decisive property: it never produced the vision-API egress payload.
    expect(res._image).toBeUndefined();
  });

  it("accepts a real PNG and emits the _image egress payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-viewimg-ok-"));
    dirs.add(dir);
    const p = join(dir, "real.png");
    writeFileSync(p, PNG_1x1);

    const res: any = await viewImageTool.execute({ path: p });
    expect(res.isError).toBeFalsy();
    expect(res._image).toBeTruthy();
    expect(res._image.mime).toBe("image/png");
    expect(res._image.b64).toBe(PNG_1x1.toString("base64"));
  });
});

// Real-fs test: resolveMediaPath's whole job is to find a file the standard
// workspace-anchored resolution misses (the "wrong folder" send_image bug), so
// mocking existsSync would just test the mock — use a real temp file in uploads.
describe("resolveMediaPath uploads fallback", () => {
  const uploads = join(getLaxDir(), "uploads");
  const name = `test-resolve-${process.pid}.bin`;
  const full = join(uploads, name);
  afterAll(() => { try { rmSync(full); } catch { /* best effort */ } });

  it("falls back to ~/.lax/uploads by basename when the workspace resolution misses", () => {
    mkdirSync(uploads, { recursive: true });
    writeFileSync(full, "x");
    expect(resolveMediaPath(name)).toBe(full);
  });

  it("returns the standard resolution for an absolute path that exists (no fallback)", () => {
    expect(resolveMediaPath(full)).toBe(full);
  });

  it("returns the standard resolution (not uploads) when the file exists nowhere — clear error", () => {
    const missing = `does-not-exist-${process.pid}.bin`;
    expect(resolveMediaPath(missing)).not.toContain(join("uploads", missing));
  });
});
