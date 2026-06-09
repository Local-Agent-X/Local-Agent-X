// R4-20: view_image must gate on the file's MAGIC BYTES, not its extension. A
// non-image file renamed `.png` (an exported secret, a sqlite db, a json blob)
// previously sailed past the extension-only check and base64-shipped to the
// vision provider. The magic-byte detectMime gate now rejects it before egress.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { viewImageTool } from "./vision-tools.js";

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
