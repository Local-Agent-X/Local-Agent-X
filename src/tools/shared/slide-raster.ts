/**
 * A slide plan drawn to pixels with the bundled canvas, so the agent can look
 * at the deck it made on any machine, with no LibreOffice or PowerPoint.
 * Text is drawn from the lines the fit wrapped (slide-text-fit.ts), charts
 * from the same SVG the chart tool rasterizes, so what is drawn is what was
 * laid out.
 */
import { renderChartPng } from "./office-chart.js";
import type { OfficeTheme } from "./office-theme.js";
import { SLIDE_H, SLIDE_W, type SlidePlan, type TextElement } from "./slide-plan.js";
import { LINE_HEIGHT_EM, cssFont } from "./slide-text-fit.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const hex = (c: string) => `#${c.replace(/^#/, "")}`;

function drawText(ctx: any, el: TextElement, ppi: number): void {
  const k = ppi / 72; // points → pixels
  const size = el.fit.size;
  const lineH = size * LINE_HEIGHT_EM * el.lineSpacing * k;
  const gap = size * el.paraGap * k;
  const x0 = el.box.x * ppi, w = el.box.w * ppi;
  const used = el.fit.height * ppi;
  const boxH = el.box.h * ppi;
  let y = el.box.y * ppi + (el.valign === "middle" ? (boxH - used) / 2 : el.valign === "bottom" ? boxH - used : 0);
  ctx.fillStyle = hex(el.color);
  ctx.font = cssFont(size * k, el);
  ctx.textBaseline = "alphabetic";
  const indent = el.fit.indent * k;
  el.fit.lines.forEach((lines, pi) => {
    lines.forEach((line, li) => {
      const baseline = y + lineH * 0.8;
      if (el.bullets && li === 0) ctx.fillText("•", x0, baseline);
      const tx = x0 + indent;
      const lw = ctx.measureText(line).width;
      const ax = el.align === "center" ? x0 + (w - lw) / 2 : el.align === "right" ? x0 + w - lw : tx;
      ctx.fillText(line, ax, baseline);
      y += lineH;
    });
    if (pi < el.fit.lines.length - 1) y += gap;
  });
}

/** Draw one plan; returns the canvas (for the contact sheet) at `ppi`. */
export async function rasterSlide(plan: SlidePlan, t: OfficeTheme, ppi = 100): Promise<any> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const canvas = createCanvas(Math.round(SLIDE_W * ppi), Math.round(SLIDE_H * ppi));
  const ctx: any = canvas.getContext("2d");
  ctx.fillStyle = hex(plan.background);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const el of plan.elements) {
    const b = { x: el.box.x * ppi, y: el.box.y * ppi, w: el.box.w * ppi, h: el.box.h * ppi };
    if (el.kind === "rect") {
      ctx.globalAlpha = el.transparency ? 1 - el.transparency / 100 : 1;
      ctx.fillStyle = hex(el.color);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = 1;
    } else if (el.kind === "ellipse") {
      ctx.fillStyle = hex(el.color);
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.kind === "text") {
      drawText(ctx, el, ppi);
    } else if (el.kind === "image") {
      try { ctx.drawImage(await loadImage(el.image.buffer), b.x, b.y, b.w, b.h); } catch { /* an image the canvas cannot decode is left out of the preview only */ }
    } else if (el.kind === "chart") {
      try {
        const png = await renderChartPng(el.chart, t, { W: Math.round(b.w), H: Math.round(b.h) });
        ctx.drawImage(await loadImage(png), b.x, b.y, b.w, b.h);
      } catch { /* the preview shows the chart's frame; the deck still has the native chart */ }
    }
  }
  return canvas;
}

/** Slides tiled into contact sheets of up to nine, each numbered, as JPEG:
 *  what the agent looks at before it hands the deck over. */
export async function contactSheets(plans: SlidePlan[], t: OfficeTheme): Promise<Buffer[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const cols = 3, perSheet = 9, thumbW = 520, thumbH = Math.round(thumbW * SLIDE_H / SLIDE_W), pad = 14;
  const sheets: Buffer[] = [];
  for (let start = 0; start < plans.length; start += perSheet) {
    const chunk = plans.slice(start, start + perSheet);
    const rows = Math.ceil(chunk.length / cols);
    const sheet = createCanvas(cols * thumbW + (cols + 1) * pad, rows * thumbH + (rows + 1) * pad);
    const ctx: any = sheet.getContext("2d");
    ctx.fillStyle = "#3A3F47";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    for (let i = 0; i < chunk.length; i++) {
      const slide = await rasterSlide(chunk[i], t, 100);
      const x = pad + (i % cols) * (thumbW + pad), y = pad + Math.floor(i / cols) * (thumbH + pad);
      ctx.drawImage(slide, x, y, thumbW, thumbH);
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(x, y, 34, 24);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "bold 15px Arial";
      ctx.fillText(String(start + i + 1), x + 8, y + 17);
    }
    sheets.push(sheet.toBuffer("image/jpeg", 82));
  }
  return sheets;
}
