/**
 * Themed chart rendering — one source of truth for turning chart data into a
 * raster image (SVG → PNG via sharp) so charts can be embedded in Word, Excel,
 * and PDF (which can't draw native charts the way PowerPoint can). PowerPoint
 * keeps its NATIVE editable charts; this is for the raster-only formats.
 *
 * The chart TYPES live here so pptx-render and the create_chart tool share one
 * definition.
 */
import type { OfficeTheme } from "./office-theme.js";

const CHART_TYPES = ["bar", "line", "pie", "doughnut", "area", "radar", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSpec {
  type: ChartType;
  categories?: string[];
  series: { name: string; values: number[] }[];
  title?: string;
}

export function isValidChart(c: ChartSpec | undefined): c is ChartSpec {
  return !!c && CHART_TYPES.includes(c.type) && Array.isArray(c.series) && c.series.length > 0
    && c.series.every((s) => Array.isArray(s.values) && s.values.length > 0);
}

const esc = (s: string): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};
const hx = (c: string): string => "#" + c.replace(/^#/, "");

interface Geo { W: number; H: number }

/** Render a chart to a themed SVG string. */
export function renderChartSvg(spec: ChartSpec, t: OfficeTheme, geo: Geo = { W: 760, H: 460 }): string {
  const { W, H } = geo;
  const font = `${t.fonts.body}, Arial, Helvetica, sans-serif`;
  const palette = t.chartPalette.map(hx);
  const ink = hx(t.colors.body), grid = hx(t.colors.border), head = hx(t.colors.heading), muted = hx(t.colors.muted);
  const cats = spec.categories ?? spec.series[0].values.map((_, i) => `#${i + 1}`);
  const isPie = spec.type === "pie" || spec.type === "doughnut";
  const multi = spec.series.length > 1;
  const showLegend = isPie || multi;

  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>`);
  let top = 16;
  if (spec.title) {
    parts.push(`<text x="${W / 2}" y="26" text-anchor="middle" font-family="${font}" font-size="18" font-weight="700" fill="${head}">${esc(spec.title)}</text>`);
    top = 44;
  }
  const padL = 58, padR = 18, padB = 40 + (showLegend ? 26 : 0);
  const plotW = W - padL - padR, plotH = H - top - padB;
  const x0 = padL, y0 = top;

  if (isPie) {
    parts.push(renderPie(spec, palette, ink, font, { W, H, top, padB, showLegend }));
  } else {
    // value axis
    const allVals = spec.series.flatMap((s) => s.values);
    const maxV = Math.max(1, ...allVals);
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (maxV * i) / ticks;
      const y = y0 + plotH - (v / maxV) * plotH;
      parts.push(`<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x0 + plotW}" y2="${y.toFixed(1)}" stroke="${grid}" stroke-width="1"/>`);
      parts.push(`<text x="${x0 - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${font}" font-size="11" fill="${muted}">${esc(fmt(v))}</text>`);
    }
    const n = cats.length;
    const groupW = plotW / n;
    // category labels
    cats.forEach((c, i) => {
      const cx = x0 + groupW * (i + 0.5);
      parts.push(`<text x="${cx.toFixed(1)}" y="${(y0 + plotH + 18).toFixed(1)}" text-anchor="middle" font-family="${font}" font-size="11" fill="${muted}">${esc(c)}</text>`);
    });
    const toY = (v: number) => y0 + plotH - (v / maxV) * plotH;

    if (spec.type === "bar") {
      const inner = groupW * 0.7, bw = inner / spec.series.length;
      spec.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          const bx = x0 + groupW * i + (groupW - inner) / 2 + si * bw;
          const by = toY(v), bh = y0 + plotH - by;
          parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" fill="${palette[si % palette.length]}"/>`);
        });
      });
    } else {
      // line / area
      spec.series.forEach((s, si) => {
        const color = palette[si % palette.length];
        const pts = s.values.map((v, i) => `${(x0 + groupW * (i + 0.5)).toFixed(1)},${toY(v).toFixed(1)}`);
        if (spec.type === "area") {
          const base = `${(x0 + groupW * 0.5).toFixed(1)},${(y0 + plotH).toFixed(1)}`;
          const baseEnd = `${(x0 + groupW * (s.values.length - 0.5)).toFixed(1)},${(y0 + plotH).toFixed(1)}`;
          parts.push(`<polygon points="${base} ${pts.join(" ")} ${baseEnd}" fill="${color}" fill-opacity="0.18"/>`);
        }
        parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
        s.values.forEach((v, i) => parts.push(`<circle cx="${(x0 + groupW * (i + 0.5)).toFixed(1)}" cy="${toY(v).toFixed(1)}" r="3" fill="${color}"/>`));
      });
    }
    // axes
    parts.push(`<line x1="${x0}" y1="${y0 + plotH}" x2="${x0 + plotW}" y2="${y0 + plotH}" stroke="${ink}" stroke-width="1"/>`);
  }

  if (showLegend) {
    const items = isPie ? cats : spec.series.map((s) => s.name);
    const colorOf = (i: number) => palette[i % palette.length];
    const ly = H - 16;
    let lx = padL;
    items.forEach((label, i) => {
      parts.push(`<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${colorOf(i)}"/>`);
      parts.push(`<text x="${lx + 16}" y="${ly}" font-family="${font}" font-size="11" fill="${ink}">${esc(label)}</text>`);
      lx += 26 + esc(label).length * 6.2;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

function renderPie(spec: ChartSpec, palette: string[], ink: string, font: string, g: { W: number; H: number; top: number; padB: number; showLegend: boolean }): string {
  const vals = spec.series[0].values;
  const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const cx = g.W / 2, cy = g.top + (g.H - g.top - g.padB) / 2;
  const r = Math.min(g.W, g.H - g.top - g.padB) / 2 - 8;
  const inner = spec.type === "doughnut" ? r * 0.55 : 0;
  let angle = -Math.PI / 2;
  const out: string[] = [];
  vals.forEach((v, i) => {
    const frac = Math.max(0, v) / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`;
    const path = inner > 0
      ? `M ${p(r, angle)} A ${r} ${r} 0 ${large} 1 ${p(r, a2)} L ${p(inner, a2)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, angle)} Z`
      : `M ${cx} ${cy} L ${p(r, angle)} A ${r} ${r} 0 ${large} 1 ${p(r, a2)} Z`;
    out.push(`<path d="${path}" fill="${palette[i % palette.length]}"/>`);
    if (frac > 0.04) {
      const mid = (angle + a2) / 2, lr = inner > 0 ? (r + inner) / 2 : r * 0.62;
      out.push(`<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" font-family="${font}" font-size="11" font-weight="700" fill="#FFFFFF">${Math.round(frac * 100)}%</text>`);
    }
    angle = a2;
  });
  return out.join("");
}

/** Render a chart to a PNG buffer (themed). sharp rasterizes the SVG. */
export async function renderChartPng(spec: ChartSpec, theme: OfficeTheme, geo?: Geo): Promise<Buffer> {
  const svg = renderChartSvg(spec, theme, geo);
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
