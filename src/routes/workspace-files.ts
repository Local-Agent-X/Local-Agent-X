import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeParseBody, corsHeaders } from "../server-utils.js";

/** Extensions the workspace-root file manager is allowed to touch. */
const WS_FILE_EXTS = new Set(["pptx", "docx", "xlsx", "pdf", "txt", "md", "csv"]);

/**
 * Workspace-ROOT file listing/rename/delete — operates on `workspace/` itself
 * (generated docs/spreadsheets/etc.), distinct from the `/api/apps/<id>/files`
 * routes that target `workspace/apps/<id>/`. Split out of routes/apps.ts to keep
 * that file under the source-hygiene LOC cap; mirrors the lazy-import shape of
 * handleAppSnapshotsRoutes. Returns true when it claimed the request.
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
