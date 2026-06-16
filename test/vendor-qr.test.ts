// Cross-checks the vendored, network-free QR generator (public/vendor/qr) the
// desktop "Pair a phone" panel uses, against the trusted `qrcode` reference
// encoder already in node_modules. The vendored lib is a browser IIFE that
// attaches `LaxQR` to its global; we run it via `new Function` (same way the
// browser would) and compare module matrices BYTE mode ↔ byte mode at the same
// mask. Equality proves correct data placement, ECC, interleaving, and version
// selection — a real reference cross-check, not a mock.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Narrow ambient type for the reference encoder (the `qrcode` package ships no
// types). Only the `create` surface we use is declared — keeps the test off
// `any` without pulling in @types/qrcode.
import QRCode from "qrcode";

interface QrModules { size: number; data: ArrayLike<boolean | number>; }
interface LaxMatrix { size: number; mask: number; modules: boolean[][]; isFunction: boolean[][]; }
interface LaxQRApi {
  encodeText(text: string, ecl: string): LaxMatrix;
  toSvg(matrix: LaxMatrix, opts?: { border?: number }): string;
}

// Load the vendored browser IIFE into an isolated global-ish object.
function loadLaxQR(): LaxQRApi {
  const vendorUrl = new URL("../public/vendor/qr/qrcode.js", import.meta.url);
  const src = readFileSync(fileURLToPath(vendorUrl), "utf-8");
  const sandbox: { LaxQR?: LaxQRApi; window?: unknown } = {};
  // The IIFE takes a single arg it treats as `global` and assigns `.LaxQR`.
  new Function("globalThis", src)(sandbox);
  if (!sandbox.LaxQR) throw new Error("vendored qrcode.js did not export LaxQR");
  return sandbox.LaxQR;
}

// Build the reference matrix forcing BYTE mode (so the comparison is apples to
// apples — the reference otherwise picks denser numeric/alphanumeric modes).
function refByteMatrix(text: string, mask: number): QrModules {
  const bytes = Buffer.from(text, "utf-8");
  const qr = QRCode.create([{ data: bytes, mode: "byte" }], {
    errorCorrectionLevel: "M",
    maskPattern: mask,
  });
  return qr.modules as unknown as QrModules;
}

function dataDiffs(mine: LaxMatrix, ref: QrModules): number {
  let diff = 0;
  for (let y = 0; y < mine.size; y++) {
    for (let x = 0; x < mine.size; x++) {
      if (mine.isFunction[y][x]) continue; // mask-independent function modules
      if (Boolean(ref.data[y * ref.size + x]) !== mine.modules[y][x]) diff++;
    }
  }
  return diff;
}

describe("vendored QR generator ↔ reference qrcode (byte mode)", () => {
  const LaxQR = loadLaxQR();

  const cases: Array<[string, string]> = [
    ["short", "HI"],
    ["one-block v1", "hello world"],
    ["v2", "0123456789012345678901234"],
    [
      "real pairing payload (multi-block v6)",
      JSON.stringify({
        v: 1,
        tailnetAddr: "100.100.1.2:7007",
        pairingSecret: "abc123_DEF-xyz789secretsecretsec",
        expiresAt: 1750000000000,
      }),
    ],
  ];

  for (const [label, text] of cases) {
    it(`is byte-identical to the reference for ${label}`, () => {
      const mine = LaxQR.encodeText(text, "M");
      const ref = refByteMatrix(text, mine.mask);
      expect(mine.size).toBe(ref.size); // same auto-selected version
      expect(dataDiffs(mine, ref)).toBe(0);
    });
  }

  it("renders a self-contained SVG (no external refs) for the pairing payload", () => {
    const payload = JSON.stringify({ v: 1, tailnetAddr: "100.100.1.2:7007", pairingSecret: "s", expiresAt: 1 });
    const svg = LaxQR.toSvg(LaxQR.encodeText(payload, "M"), { border: 2 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
    // Inline geometry only — no external resource fetches (the xmlns URI is a
    // namespace identifier, not a network request).
    expect(svg).not.toMatch(/\b(?:href|src)=/);
    expect(svg).not.toContain("url(");
  });
});
