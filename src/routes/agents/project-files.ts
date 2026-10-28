// A chat project's documents folder from the sidebar: list what is in it and
// add files to it ("Add files"). The project-docs index watches the folder,
// so an added file is searchable from the project's chats a moment later.

import { existsSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { workspaceRoot } from "../../config.js";
import { browseWorkspaceFolder } from "../workspace-files.js";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, parseMultipart } from "../../server-utils.js";
import { projectDocsDir, projectDocsFolders } from "../../memory/project-docs/folders.js";
import { isDocumentFile } from "../../memory/project-docs/extract.js";

const FILES_PATH = /^\/api\/projects\/(proj-[A-Za-z0-9_-]+)\/files$/;

/** The name as the user gave it, made safe to write on any OS: no folders,
 *  no characters Windows refuses, never hidden. */
export function safeDocName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").slice(0, 180);
  return cleaned || "document";
}

/** `name`, or `name (2).ext`, `name (3).ext`... when a file already has it. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

export const handleProjectFileRoutes: RouteHandler = async (method, url, req, res, ctx) => {
  const match = FILES_PATH.exec(url.pathname);
  if (!match || (method !== "GET" && method !== "POST")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const project = ctx.projectStore.get(match[1]);
  if (!project || project.codeFolder) { json(404, { error: "Project not found" }); return true; }
  projectDocsFolders(project);
  const dir = projectDocsDir(project.id);

  if (method === "GET") {
    const listing = browseWorkspaceFolder(workspaceRoot(), join("projects", project.id));
    const files = (listing?.entries ?? []).map((e) => ({ name: e.kind === "dir" ? `${e.name}/` : e.name, size: e.size }));
    json(200, { folder: dir, files });
    return true;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > ctx.config.maxUploadBytes) {
      json(413, { error: `Too large. Max ${Math.round(ctx.config.maxUploadBytes / 1048576)}MB per upload.` });
      req.destroy();
      return true;
    }
    chunks.push(chunk as Buffer);
  }
  const boundary = /boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/.exec(req.headers["content-type"] || "");
  if (!boundary) { json(400, { error: "Multipart form data required" }); return true; }

  const added: string[] = [];
  const refused: string[] = [];
  for (const part of parseMultipart(Buffer.concat(chunks), boundary[1] || boundary[2])) {
    if (!part.filename) continue;
    const name = safeDocName(part.filename);
    if (!isDocumentFile(name)) { refused.push(part.filename); continue; }
    const finalName = freeName(dir, name);
    writeFileSync(join(dir, finalName), part.data);
    added.push(finalName);
  }
  if (added.length) {
    try {
      const { broadcastAll } = await import("../../chat-ws/index.js");
      broadcastAll({ type: "projects_changed" });
    } catch { /* no WS context (tests, scripts): the files are written regardless */ }
  }
  json(added.length || !refused.length ? 200 : 400, {
    folder: dir,
    added,
    refused,
    ...(refused.length ? { error: "Only documents can be added: PDF, Word, PowerPoint, text, Markdown, CSV, JSON, YAML, XML or HTML." } : {}),
  });
  return true;
};
