/**
 * Reads a finished PDF back and reports layout mistakes a person would see:
 * a blank page, text drawn over an image, text running off the page.
 *
 * The pdf tool's create action runs it on every file it writes, so a layout
 * bug reaches the agent as a problem in the result instead of a PDF the user
 * opens to find wrong (blank pages after the content, a caption printed across
 * a picture: 2026-11-18). It reads the file itself, not the layout the tool
 * meant to draw, so it catches what the drawing library did too.
 */

/** Text this close to the bottom edge is the page footer, not content. */
const FOOTER_BAND = 50;
/** Overlap smaller than this (points²) is a glyph touching an edge, not text over a picture. */
const MIN_OVERLAP_AREA = 20;

interface Rect { x0: number; y0: number; x1: number; y1: number }
type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The unit square an image is painted into, through the current matrix. */
function imageRect(m: Matrix): Rect {
  const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
  const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

interface PageLayout { width: number; text: Array<{ str: string; rect: Rect }>; images: Rect[] }

async function readPages(pdf: Buffer): Promise<PageLayout[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: PageLayout[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = (content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>)
        .filter((i) => typeof i.str === "string" && i.str.trim() && i.transform)
        .map((i) => {
          const [, , , , x, y] = i.transform!;
          return { str: i.str!, rect: { x0: x, y0: y, x1: x + (i.width ?? 0), y1: y + (i.height ?? 0) } };
        });
      const ops = await page.getOperatorList();
      const images: Rect[] = [];
      const stack: Matrix[] = [];
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, ops.argsArray[k] as Matrix);
        else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) images.push(imageRect(ctm));
      }
      pages.push({ width: page.view[2] - page.view[0], text, images });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Plain-language problems, one per finding; empty when the PDF looks right. */
export async function checkPdfLayout(pdf: Buffer): Promise<string[]> {
  const problems: string[] = [];
  const pages = await readPages(pdf);
  pages.forEach((p, i) => {
    const n = i + 1;
    const content = p.text.filter((t) => t.rect.y0 > FOOTER_BAND);
    if (content.length === 0 && p.images.length === 0) problems.push(`page ${n} of ${pages.length} is blank`);
    const over = content.filter((t) => p.images.some((img) => overlapArea(t.rect, img) >= MIN_OVERLAP_AREA));
    if (over.length) problems.push(`page ${n}: text is drawn over an image ("${over[0]!.str.slice(0, 60)}")`);
    const off = content.filter((t) => t.rect.x1 > p.width + 1 || t.rect.x0 < -1);
    if (off.length) problems.push(`page ${n}: text runs off the page ("${off[0]!.str.slice(0, 60)}")`);
  });
  return problems;
}
