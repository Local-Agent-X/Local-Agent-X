import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { workspacePath } from "../config.js";
import { resolveOfficeTheme, THEME_PARAM_SCHEMA } from "./shared/office-theme.js";
import { renderChartPng, isValidChart, type ChartSpec, type ChartType } from "./shared/office-chart.js";
import { verifyWriteLanded } from "./verify.js";

// Charts are an intermediate to be embedded, so anchor output UNDER the
// workspace (and return the absolute path): that's exactly where the image
// acquirer will accept it from when the agent embeds it. A "workspace/" prefix
// is tolerated and stripped.
function chartOutPath(p: string): string {
  let fp = isAbsolute(p) ? resolve(p) : join(workspacePath(), p.replace(/^\.?\/?workspace\//, "").replace(/^\/+/, ""));
  if (!/\.png$/i.test(fp)) fp += ".png";
  return fp;
}

const chartCreate: ToolDefinition = {
  name: "create_chart",
  description:
    "Render a themed chart to a PNG you can embed in a Word doc, Excel sheet, or PDF — those formats " +
    "can't draw native charts, so generate the image here, then pass the RETURNED path as an image " +
    "`source` to document_create / spreadsheet_write / pdf_create. (PowerPoint has native charts — use " +
    "the slide `chart` field there instead.) Types: bar, line, area, pie, doughnut.",
  parameters: {
    type: "object",
    required: ["file_path", "type", "series"],
    properties: {
      file_path: { type: "string", description: "Output .png path (saved under the workspace)" },
      type: { type: "string", enum: ["bar", "line", "area", "pie", "doughnut"], description: "Chart type" },
      title: { type: "string", description: "Chart title" },
      categories: { type: "array", items: { type: "string" }, description: "Category / x-axis labels (or pie slice labels)" },
      series: { type: "string", description: 'JSON array of series: [{"name":"Revenue","values":[124,98,76]}]. Pie/doughnut use the first series.' },
      width: { type: "number", description: "Image width in px (default 760)" },
      height: { type: "number", description: "Image height in px (default 460)" },
      theme: THEME_PARAM_SCHEMA,
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      let series: ChartSpec["series"];
      try { series = JSON.parse(String(args.series)); }
      catch { return { content: "series must be a JSON array like [{\"name\":\"X\",\"values\":[1,2,3]}]", isError: true }; }
      const spec: ChartSpec = {
        type: String(args.type) as ChartType,
        title: args.title ? String(args.title) : undefined,
        categories: args.categories as string[] | undefined,
        series,
      };
      if (!isValidChart(spec)) return { content: "Invalid chart: need a valid type and a non-empty series with numeric values.", isError: true };

      const theme = resolveOfficeTheme(args.theme);
      const png = await renderChartPng(spec, theme, { W: Number(args.width) || 760, H: Number(args.height) || 460 });
      const fp = chartOutPath(String(args.file_path));
      mkdirSync(dirname(fp), { recursive: true });
      await writeFile(fp, png);
      const v = verifyWriteLanded(fp, { minBytes: 100 });
      if (!v.ok) return { content: `Failed to write chart: ${v.reason}`, isError: true };
      return { content: `Created ${spec.type} chart: ${fp} (${png.length} bytes). Embed it by passing this path as an image source.`, metadata: { file_path: fp } };
    } catch (e) {
      return { content: `Failed to create chart: ${(e as Error).message}`, isError: true };
    }
  },
};

export const chartTools: ToolDefinition[] = [chartCreate];
