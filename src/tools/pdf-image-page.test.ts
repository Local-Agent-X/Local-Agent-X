// An image page in a created PDF: the image sits inside the margins and its
// caption is under it, never drawn over it. pdfkit's valign "center" put a
// wide image lower on the page than the caption that followed (2026-11-18).
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { renderImagePage } from "./pdf-render.js";
import { resolveOfficeTheme } from "./shared/office-theme.js";

/** A solid-colour RGB PNG of the given size. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const theme = resolveOfficeTheme(undefined);

function layout(width: number, height: number, caption?: string) {
  const doc = new PDFDocument({ bufferPages: true });
  const placed = renderImagePage(doc, png(width, height), caption, theme);
  const page = doc.page;
  doc.end();
  return { ...placed, page };
}

describe("an image page", () => {
  it.each([
    ["a wide slide", 800, 450],
    ["a tall scan", 400, 1200],
    ["a square", 600, 600],
  ])("%s: the caption is under the image, and both are inside the margins", (_label, w, h) => {
    const { top, bottom, captionTop, page } = layout(w, h, "Plate: intrinsic hand-muscle reference. Source: an educational slide.");
    expect(top).toBe(page.margins.top);
    expect(captionTop!).toBeGreaterThan(bottom);
    expect(captionTop! + 40).toBeLessThanOrEqual(page.height - page.margins.bottom);
  });

  it("the image never runs past the right margin", () => {
    const doc = new PDFDocument();
    const calls: Array<{ x: number; w: number }> = [];
    const image = doc.image.bind(doc);
    doc.image = (src: Buffer, x: number, y: number, opts: { width: number }) => { calls.push({ x, w: opts.width }); return image(src, x, y, opts); };
    renderImagePage(doc, png(2000, 300), undefined, theme);
    expect(calls[0]!.x).toBeGreaterThanOrEqual(doc.page.margins.left);
    expect(calls[0]!.x + calls[0]!.w).toBeLessThanOrEqual(doc.page.width - doc.page.margins.right + 0.01);
    doc.end();
  });
});
