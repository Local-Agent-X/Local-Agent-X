import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { confineToDir } from "../security/layer/file-access.js";
import { isSensitivePath } from "../data-lineage/index.js";
import { realpathDeep } from "../workspace/paths.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeParseBody, corsHeaders } from "../server-utils.js";

/** Extensions the workspace-root file manager is allowed to touch. */
const WS_FILE_EXTS = new Set(["pptx", "docx", "xlsx", "pdf", "txt", "md", "csv"]);

/**
 * Workspace-ROOT file listing/rename/delete — operates on `workspace/` itself
 * (generated docs/spreadsheets/etc.), distinct from the `/api/apps/<id>/files`
 * routes that target `workspace/apps/<id>/`. Split out of routes/apps.ts, which
 * lazy-imports it the same way as handleAppSnapshotsRoutes. Returns true when
 * it claimed the request.
 */
export async function handleWorkspaceFilesRoutes(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  json: (status: number, data: unknown) => void,
  workspace: string,
): Promise<boolean> {
  const wsRoot = resolve(workspace);

  if (method === "GET" && url.pathname === "/api/workspace/files") {
    const extParam = url.searchParams.get("ext") || "";
    const exts = new Set(extParam.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    if (!existsSync(wsRoot)) { json(200, []); return true; }
    try {
      const out: Array<{ name: string; size: number; mtime: number; url: string }> = [];
      for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const dot = entry.name.lastIndexOf(".");
        const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
        if (exts.size && !exts.has(ext)) continue;
        const st = statSync(join(wsRoot, entry.name));
        out.push({
          name: entry.name, size: st.size, mtime: st.mtimeMs,
          url: `/files/${encodeURIComponent(entry.name)}`,
        });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      json(200, out);
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/workspace/browse") {
    const listing = browseWorkspaceFolder(wsRoot, url.searchParams.get("dir") || "");
    if (!listing) { json(404, { error: "Folder not found" }); return true; }
    json(200, listing);
    return true;
  }

  const wsRenameMatch = url.pathname.match(/^\/api\/workspace\/files\/(.+)\/rename$/);
  if (method === "POST" && wsRenameMatch) {
    const oldName = decodeURIComponent(wsRenameMatch[1]);
    const body = await safeParseBody(req);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      json(400, { error: "name required" }); return true;
    }
    const newName = body.name.trim();
    for (const n of [oldName, newName]) {
      if (!n || n.startsWith(".") || n.includes("/") || n.includes("\\") || n.includes("..")) {
        json(400, { error: "Invalid filename" }); return true;
      }
    }
    const oldDot = oldName.lastIndexOf(".");
    const newDot = newName.lastIndexOf(".");
    const oldExt = oldDot >= 0 ? oldName.slice(oldDot + 1).toLowerCase() : "";
    const newExt = newDot >= 0 ? newName.slice(newDot + 1).toLowerCase() : "";
    if (!WS_FILE_EXTS.has(oldExt) || !WS_FILE_EXTS.has(newExt)) {
      json(400, { error: "Extension not allowed" }); return true;
    }
    if (oldExt !== newExt) { json(400, { error: "Extension must match" }); return true; }
    const oldPath = resolve(wsRoot, oldName);
    const newPath = resolve(wsRoot, newName);
    if (!oldPath.startsWith(wsRoot) || !newPath.startsWith(wsRoot)) {
      json(403, { error: "Path traversal blocked" }); return true;
    }
    if (!existsSync(oldPath)) { json(404, { error: "File not found" }); return true; }
    if (existsSync(newPath)) { json(409, { error: "Target already exists" }); return true; }
    try {
      const { renameSync } = await import("node:fs");
      renameSync(oldPath, newPath);
      json(200, { ok: true, name: newName });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  const wsDeleteMatch = url.pathname.match(/^\/api\/workspace\/files\/([^/]+)$/);
  if (method === "DELETE" && wsDeleteMatch) {
    const name = decodeURIComponent(wsDeleteMatch[1]);
    if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("..")) {
      json(400, { error: "Invalid filename" }); return true;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!WS_FILE_EXTS.has(ext)) { json(400, { error: "Extension not allowed" }); return true; }
    const filePath = resolve(wsRoot, name);
    if (!filePath.startsWith(wsRoot)) { json(403, { error: "Path traversal blocked" }); return true; }
    if (!existsSync(filePath)) { json(404, { error: "File not found" }); return true; }
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(filePath);
      json(200, { ok: true });
    } catch (e) { json(500, { error: (e as Error).message }); }
    return true;
  }

  return false;
}

/** Most entries one folder listing returns. */
const BROWSE_MAX_ENTRIES = 1000;

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file";
  /** Path inside the workspace, "/"-separated: the next `dir`, or the file's /files/ path. */
  path: string;
  size: number;
  mtime: number;
}

/**
 * One workspace folder's folders and files, for the phone's file explorer (2026-10-24).
 * `dir` is resolved through confineToDir (symlinks followed to their real target and
 * kept inside the workspace, credential paths refused), so a link planted in the
 * workspace cannot list the folder it points at. Inside, a link is not listed at all,
 * nor a dot-file, node_modules, or a credential file. Folders first, then by name.
 * Null when `dir` is not a folder inside the workspace.
 */
export function browseWorkspaceFolder(wsRoot: string, dir: string): { dir: string; entries: WorkspaceEntry[] } | null {
  const folder = confineToDir(wsRoot, dir || ".");
  if (!folder) return null;
  let realRoot: string;
  try {
    if (!statSync(folder).isDirectory()) return null;
    realRoot = realpathDeep(resolve(wsRoot));
  } catch {
    return null;
  }
  const relDir = relative(realRoot, folder).split(sep).join("/");
  const entries: WorkspaceEntry[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entries.length >= BROWSE_MAX_ENTRIES) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (isSensitivePath(rel)) continue;
    let st;
    try { st = statSync(join(folder, entry.name)); } catch { continue; /* gone between the read and the stat */ }
    entries.push({ name: entry.name, kind: entry.isDirectory() ? "dir" : "file", path: rel, size: entry.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { dir: relDir, entries };
}
