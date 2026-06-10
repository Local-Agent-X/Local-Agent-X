import { existsSync } from "node:fs";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveAgentPath as resolvePath } from "../workspace/paths.js";
import { docKind, extractStructure, renderThumbnail } from "./shared/office-preview.js";

const previewDocument: ToolDefinition = {
  name: "preview_document",
  description:
    "Self-check a generated document/deck/sheet/PDF before handing it off. Re-opens the file, reports " +
    "its structure (pages/slides/rows + a text preview), flags problems (empty output, leaked markup), and " +
    "renders a page-1 PNG thumbnail you can then view_image to confirm it looks right. PDFs always render a " +
    "thumbnail; Word/Excel/PowerPoint render one when LibreOffice is installed (otherwise the structural " +
    "check still runs). Use after creating a file to verify it actually came out as intended.",
  parameters: {
    type: "object",
    required: ["file_path"],
    properties: {
      file_path: { type: "string", description: "Path to the generated .docx / .pdf / .xlsx / .pptx file" },
      thumbnail: { type: "boolean", description: "Render a page-1 PNG thumbnail (default true)" },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const fp = resolvePath(String(args.file_path));
      if (!existsSync(fp)) return { content: `File not found: ${fp}`, isError: true };
      const kind = docKind(fp);
      if (kind === "unknown") return { content: `Unsupported file type for preview: ${fp}`, isError: true };

      const report = await extractStructure(fp, kind);
      const lines = [`${kind.toUpperCase()} — ${report.summary}`];
      lines.push(report.flags.length ? `⚠ ${report.flags.join("; ")}` : "✓ no structural problems detected");

      let thumbnail: string | undefined;
      if (args.thumbnail !== false) {
        const out = fp.replace(/\.[^.]+$/, "") + ".preview.png";
        const t = await renderThumbnail(fp, kind, out);
        if (t.ok) { thumbnail = t.outPath; lines.push(`Thumbnail: ${t.outPath} — view_image it to confirm the layout.`); }
        else lines.push(`Thumbnail: ${t.reason}`);
      }
      if (report.textPreview) lines.push("", "--- text preview ---", report.textPreview);

      return { content: lines.join("\n"), metadata: { kind, flags: report.flags, thumbnail } };
    } catch (e) {
      return { content: `Preview failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const previewTools: ToolDefinition[] = [previewDocument];
