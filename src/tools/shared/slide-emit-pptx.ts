/**
 * A slide plan written into a pptxgenjs deck. Every element lands where the
 * plan put it, text at the size the fit chose with autofit off, so PowerPoint
 * shows what the preview showed. Charts are native, editable charts.
 */
import { imageAltText } from "./image-acquire.js";
import type { OfficeTheme } from "./office-theme.js";
import type { ChartSpec } from "./office-chart.js";
import { cleanText } from "./office-md.js";
import type { Box, PlanElement, SlidePlan, TextElement } from "./slide-plan.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function addText(slide: any, el: TextElement): void {
  const runs = el.paragraphs.map((text, i) => ({
    text,
    options: {
      breakLine: i < el.paragraphs.length - 1,
      ...(el.bullets ? { bullet: { indent: el.fit.indent } } : {}),
    },
  }));
  slide.addText(runs, {
    ...el.box,
    fontFace: el.font,
    fontSize: el.fit.size,
    color: el.color,
    bold: !!el.bold,
    italic: !!el.italic,
    align: el.align,
    valign: el.valign,
    margin: 0,
    fit: "none",
    lineSpacingMultiple: el.lineSpacing,
    paraSpaceAfter: Math.round(el.fit.size * el.paraGap),
  });
}

function addChart(slide: any, t: OfficeTheme, chart: ChartSpec, box: Box): void {
  const cats = chart.categories ?? chart.series[0].values.map((_, i) => `#${i + 1}`);
  const pie = chart.type === "pie" || chart.type === "doughnut";
  const data = (pie ? chart.series.slice(0, 1) : chart.series).map((s) => ({ name: s.name, labels: cats, values: s.values }));
  slide.addChart(chart.type, data, {
    ...box,
    chartColors: t.chartPalette,
    showLegend: pie || chart.series.length > 1,
    legendPos: "b",
    legendColor: t.colors.muted,
    showTitle: !!chart.title,
    title: chart.title ? cleanText(chart.title) : undefined,
    titleColor: t.colors.heading,
    titleFontFace: t.fonts.heading,
    titleFontSize: 14,
    showPercent: pie,
    catAxisLabelColor: t.colors.body,
    valAxisLabelColor: t.colors.body,
    catAxisLabelFontFace: t.fonts.body,
    valAxisLabelFontFace: t.fonts.body,
    chartColorsOpacity: 100,
  });
}

function addElement(slide: any, t: OfficeTheme, el: PlanElement): void {
  switch (el.kind) {
    case "rect":
      slide.addShape("rect", { ...el.box, fill: { color: el.color, ...(el.transparency ? { transparency: el.transparency } : {}) }, line: { type: "none" } });
      return;
    case "ellipse":
      slide.addShape("ellipse", { ...el.box, fill: { color: el.color }, line: { type: "none" } });
      return;
    case "text":
      addText(slide, el);
      return;
    case "image": {
      const data = `data:${el.image.mimeType};base64,${el.image.buffer.toString("base64")}`;
      slide.addImage({ data, ...el.box, altText: el.alt || imageAltText(el.image) });
      return;
    }
    case "chart":
      addChart(slide, t, el.chart, el.box);
      return;
  }
}

/** Write one planned slide into the deck. */
export function emitSlide(pptx: any, t: OfficeTheme, plan: SlidePlan): void {
  const slide = pptx.addSlide();
  slide.background = { color: plan.background };
  for (const el of plan.elements) addElement(slide, t, el);
  if (plan.notes) slide.addNotes(plan.notes);
}
