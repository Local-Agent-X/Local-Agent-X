import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "../types.js";
import { workspaceRoot } from "../config.js";
import { confineToDir, writeValidatedFile } from "../security/layer/index.js";
import { err } from "./result-helpers.js";
import { acquireImages, IMAGES_PARAM_SCHEMA, type ImageSpec } from "./shared/image-acquire.js";

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Marks a page this tool wrote, so a later call may replace it but never an
// app the user or app_build put at the same name.
const PAGE_MARKER = `<meta name="generator" content="lax-create-page">`;

// The page is a workspace app (<workspace>/apps/<name>/index.html), not a file
// in the install's public/ folder: the install is write-protected for the
// agent, a page there could replace the app's own UI (public/app.html), and it
// would run with the user's login token. A workspace app is served at
// /apps/<name>/ under the app CSP, without that token, and is listed with the
// other apps.
export const createPageTool: ToolDefinition = {
  name: "create_page",
  description:
    "Create a custom page as a workspace app: writes <workspace>/apps/<name>/index.html, served at /apps/<name>/ and listed with the user's apps. " +
    "Use this to build dashboards, tools, visualizations, or any custom UI directly inside the app. " +
    "The page automatically gets the app's theme CSS variables. Like every workspace app it does not get the user's login token; " +
    "to show external data, define a connector (connector_create) and call /api/connectors/<name>/<path> with Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Page slug (e.g. 'my-dashboard'). Served at /apps/<name>/" },
      title: { type: "string", description: "Human-readable page title" },
      content: { type: "string", description: "Full HTML content. Can include inline <style> and <script> tags. The app's CSS variables (--bg, --fg, --accent, etc.) are available." },
      images: IMAGES_PARAM_SCHEMA,
    },
    required: ["name", "title", "content"],
  },
  async execute(args) {
    const name = String(args.name || "page").replace(/[^a-zA-Z0-9_-]/g, "-");
    const title = String(args.title || name);
    const { images: acquired, notes: imageNotes } = await acquireImages((args.images as ImageSpec[] | undefined) ?? []);
    const imgBlock = acquired.length
      ? "\n<div class=\"acquired-images\">\n" + acquired.map(img => {
          const b64 = img.buffer.toString("base64");
          const alt = escapeHtmlAttr(img.caption || img.source);
          const cap = img.caption ? `<figcaption>${escapeHtmlAttr(img.caption)}</figcaption>` : "";
          return `<figure><img src="data:${img.mimeType};base64,${b64}" alt="${alt}" />${cap}</figure>`;
        }).join("\n") + "\n</div>\n"
      : "";
    const content = String(args.content || "") + imgBlock;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${PAGE_MARKER}
  <title>${title} — Local Agent X</title>
  <link rel="stylesheet" href="/css/theme.css">
  <style>
    body { background: var(--bg, #0a0a0a); color: var(--fg, #e0e0e0); font-family: var(--sans, system-ui, sans-serif); margin: 0; padding: 20px; }
    a { color: var(--accent, #00d4ff); }
  </style>
</head>
<body>
${content}
</body>
</html>`;

    // Resolved through links and junctions, so a link planted at apps/<name>
    // cannot carry the write out of the workspace.
    const file = confineToDir(workspaceRoot(), join("apps", name, "index.html"));
    if (!file) return err(`Cannot create page "${name}": apps/${name} resolves outside the workspace.`);
    if (existsSync(file) && !readFileSync(file, "utf-8").includes(PAGE_MARKER)) {
      return err(`An app named "${name}" already exists in the workspace and was not made by create_page. Pick another name.`);
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeValidatedFile(file, html);
      const port = process.env.LAX_PORT ?? "7007";
      const notes = imageNotes.length ? `\nImage notes:\n${imageNotes.join("\n")}` : "";
      return { content: `Page created: http://127.0.0.1:${port}/apps/${name}/\nTitle: ${title}\nListed with the apps.${notes}` };
    } catch (e) {
      return err(`Failed to create page: ${(e as Error).message}`);
    }
  },
};
