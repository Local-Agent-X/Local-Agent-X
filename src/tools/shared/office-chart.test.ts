import { describe, it, expect } from "vitest";
import { renderChartSvg, renderChartPng, isValidChart, type ChartSpec } from "./office-chart.js";
import { DEFAULT_OFFICE_THEME as T } from "./office-theme.js";

const bar: ChartSpec = { type: "bar", categories: ["A", "B", "C"], series: [{ name: "Rev", values: [10, 20, 30] }], title: "Sales" };

describe("isValidChart", () => {
  it("accepts a well-formed spec, rejects empties/bad types", () => {
    expect(isValidChart(bar)).toBe(true);
    expect(isValidChart({ type: "bar", series: [] } as any)).toBe(false);
    expect(isValidChart({ type: "bogus", series: [{ name: "x", values: [1] }] } as any)).toBe(false);
    expect(isValidChart(undefined)).toBe(false);
  });
});

describe("renderChartSvg — themed SVG per type", () => {
  it("bar: draws rects, title, navy accent", () => {
    const svg = renderChartSvg(bar, T);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Sales");
    expect(svg).toContain("<rect");
    expect(svg).toContain("#1F3A5F"); // navy palette[0]
  });
  it("line: draws a polyline", () => {
    expect(renderChartSvg({ ...bar, type: "line" }, T)).toContain("<polyline");
  });
  it("area: draws a filled polygon + polyline", () => {
    const svg = renderChartSvg({ ...bar, type: "area" }, T);
    expect(svg).toContain("<polygon");
    expect(svg).toContain("<polyline");
  });
  it("pie: draws slice paths with percent labels + legend", () => {
    const svg = renderChartSvg({ type: "pie", categories: ["X", "Y"], series: [{ name: "s", values: [3, 1] }] }, T);
    expect(svg).toContain("<path");
    expect(svg).toContain("%");
    expect(svg).toContain("X"); // legend label
  });
  it("escapes HTML in titles/labels (no markup leak into the SVG)", () => {
    const svg = renderChartSvg({ ...bar, title: "<b>x</b>" }, T);
    expect(svg).not.toContain("<b>x</b>");
    expect(svg).toContain("&lt;b&gt;");
  });
});

describe("renderChartPng — sharp rasterization", () => {
  it("produces a valid PNG buffer", async () => {
    const buf = await renderChartPng(bar, T, { W: 400, H: 260 });
    expect(buf.length).toBeGreaterThan(200);
    expect(buf[0] === 0x89 && buf.slice(1, 4).toString() === "PNG").toBe(true);
  });
});
