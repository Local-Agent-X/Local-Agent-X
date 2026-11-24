/**
 * Text measurement and fitting for slides. The one place a slide's text is
 * measured: the layout sizes each box with it, the PowerPoint writer emits the
 * size it chose, and the preview draws the lines it wrapped, so all three agree
 * on what fits.
 *
 * Measured with the bundled canvas (@napi-rs/canvas), which loads the
 * machine's fonts, so Calibri is measured as Calibri where it is installed. A
 * machine without the font measures a fallback, usually wider, which only
 * makes the fit more cautious.
 *
 * Units are points (1/72 in): a canvas font of N px measures N-point text.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** PowerPoint's single line spacing is about 1.2 em. */
export const LINE_HEIGHT_EM = 1.2;
/** Wrapping is done a little narrow, so PowerPoint's own wrap of the same text
 *  never needs a line this fit did not. */
const WIDTH_SAFETY = 1.04;

export interface TextStyle {
  font: string;
  bold?: boolean;
  italic?: boolean;
}

export interface Measurer {
  /** Width in points of `text` at `size` points. */
  width(text: string, size: number, style: TextStyle): number;
}

let measurer: Promise<Measurer> | null = null;

/** The canvas-backed measurer, loaded once. */
export function getMeasurer(): Promise<Measurer> {
  measurer ??= (async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const ctx: any = createCanvas(8, 8).getContext("2d");
    return {
      width(text: string, size: number, style: TextStyle): number {
        ctx.font = cssFont(size, style);
        return ctx.measureText(text).width as number;
      },
    };
  })();
  return measurer;
}

/** The canvas font string for a style; the preview draws with the same one. */
export function cssFont(size: number, style: TextStyle): string {
  return `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${size}px "${style.font}"`;
}

export interface FitRequest extends TextStyle {
  paragraphs: string[];
  /** Box, in inches. */
  w: number;
  h: number;
  /** Preferred size, and the smallest it may shrink to (points). */
  size: number;
  minSize: number;
  lineSpacing?: number;
  /** Bulleted paragraphs: the bullet's indent comes off the width. */
  bullets?: boolean;
  /** Space after each paragraph, in ems of the font size. */
  paraGap?: number;
}

export interface FitResult {
  size: number;
  /** Wrapped lines, per paragraph. */
  lines: string[][];
  /** Height the text takes at `size`, in inches. */
  height: number;
  /** True when even `minSize` does not fit the box. */
  overflow: boolean;
  /** Bullet indent in points (0 without bullets). */
  indent: number;
}

/** Bullet indent for a font size, in points; the writer emits the same. */
export function bulletIndent(size: number): number {
  return Math.round(size * 1.1);
}

/** Wrap one paragraph to `maxW` points. A word wider than the line is broken. */
export function wrapParagraph(m: Measurer, text: string, size: number, style: TextStyle, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  const fits = (s: string) => m.width(s, size, style) * WIDTH_SAFETY <= maxW;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) { line = candidate; continue; }
    if (line) lines.push(line);
    line = word;
    while (!fits(line) && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && !fits(line.slice(0, cut))) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function layoutAt(m: Measurer, req: FitRequest, size: number): Omit<FitResult, "overflow"> {
  const indent = req.bullets ? bulletIndent(size) : 0;
  const maxW = req.w * 72 - indent;
  const lines = req.paragraphs.map((p) => wrapParagraph(m, p, size, req, maxW));
  const lineH = size * LINE_HEIGHT_EM * (req.lineSpacing ?? 1);
  const gap = size * (req.paraGap ?? 0);
  const count = lines.reduce((n, l) => n + l.length, 0);
  const heightPts = count * lineH + Math.max(0, lines.length - 1) * gap;
  return { size, lines, height: heightPts / 72, indent };
}

/** The largest size from `size` down to `minSize` at which the text fits. */
export function fitText(m: Measurer, req: FitRequest): FitResult {
  for (let size = req.size; size >= req.minSize; size -= 1) {
    const at = layoutAt(m, req, size);
    if (at.height <= req.h) return { ...at, overflow: false };
  }
  return { ...layoutAt(m, req, req.minSize), overflow: true };
}
