// The layout check reads a finished PDF back: it finds a blank page and text
// drawn over a picture (the two mistakes users saw, 2026-11-18) and passes a
// PDF that looks right, footer included.
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error — no type declarations for pdfkit
import PDFDocument from "pdfkit";
import { checkPdfLayout } from "./pdf-layout-check.js";

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 200)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

async function build(draw: (doc: any) => void): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  doc.on("data", (c: Buffer) => chunks.push(c));
  draw(doc);
  doc.end();
  return done;
}

describe("checkPdfLayout", () => {
  it("passes a page of text, an image with its caption under it, and a footer", async () => {
    const pdf = await build((doc) => {
      doc.text("A heading and a paragraph of body text.");
      doc.addPage();
      doc.image(png(800, 400), 72, 72, { width: 468, height: 234 });
      doc.text("The caption, under the picture.", 72, 320);
      doc.page.margins.bottom = 0;
      doc.fontSize(8).text("Page 2 of 2", 72, doc.page.height - 34, { lineBreak: false });
    });
    expect(await checkPdfLayout(pdf)).toEqual([]);
  });

  it("finds a blank page, even one carrying only its footer", async () => {
    const pdf = await build((doc) => {
      doc.text("Content.");
      doc.addPage();
      doc.page.margins.bottom = 0;
      doc.fontSize(8).text("Page 2 of 2", 72, doc.page.height - 34, { lineBreak: false });
    });
    expect(await checkPdfLayout(pdf)).toEqual(["page 2 of 2 is blank"]);
  });

  it("finds text drawn over an image", async () => {
    const pdf = await build((doc) => {
      doc.image(png(800, 400), 72, 72, { width: 468, height: 234 });
      doc.text("Plate: intrinsic hand-muscle reference.", 80, 180);
    });
    expect(await checkPdfLayout(pdf)).toEqual(['page 1: text is drawn over an image ("Plate: intrinsic hand-muscle reference.")']);
  });
});
