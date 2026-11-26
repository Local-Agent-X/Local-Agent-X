/**
 * GET /api/session-folder?session=<id> — the folder a chat works in.
 *
 * The chat's terminal opens there (public/js/terminal-panel.js): its own copy
 * of the project when it has one, else its project folder; an App IDE
 * session's app folder. `{ folder: null }` for a chat with none, which opens
 * in the app's own folder as every terminal used to.
 *
 * Read from the session's record, so it answers between turns and after a
 * restart, when no work root is stamped. Reading it stamps nothing.
 *
 * GET /api/session-folder/docs?session=<id> — the project's documents the
 * owner reads: the markdown at its root and in spec/ and twins/ (a /greenfield
 * project's spec, plan, constitution and ledger). GET
 * /api/session-folder/doc?session=<id>&path=<rel> — one of them, as text. The
 * side panel's Overview lists and shows them (public/js/side-overview.js): a
 * build wrote its spec and plan and the owner had no way to read them but to
 * ask (2026-11-25).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../server-context.js";
import { isValidSessionId, jsonResponse } from "../server-utils.js";
import { sessionFolderFor } from "../session/project-folder.js";
import { confineToDir } from "../security/layer/file-access.js";

/** Where a project keeps the documents its owner reads, relative to its root. */
const DOC_DIRS = ["", "spec", "twins"];
const MAX_DOCS = 40;

function markdownIn(folder: string, dir: string): Array<{ path: string; size: number; modifiedAt: number }> {
  try {
    return readdirSync(join(folder, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        const st = statSync(join(folder, rel));
        return { path: rel, size: st.size, modifiedAt: st.mtimeMs };
      });
  } catch {
    return []; // a project without that folder has no documents there
  }
}

export const handleSessionFolderRoute: RouteHandler = async (method, url, req, res, ctx) => {
  if (method !== "GET" || !url.pathname.startsWith("/api/session-folder")) return false;
  const sub = url.pathname.slice("/api/session-folder".length);
  if (sub !== "" && sub !== "/docs" && sub !== "/doc") return false;
  const id = url.searchParams.get("session") ?? "";
  if (!isValidSessionId(id)) {
    jsonResponse(res, 400, { error: "Invalid session ID" }, req);
    return true;
  }
  const session = ctx.sessionStore.load(id);
  const folder = sessionFolderFor({ id, mode: session?.mode, projectId: session?.projectId, folder: session?.folder });
  if (sub === "") {
    jsonResponse(res, 200, { folder: folder ?? null }, req);
    return true;
  }
  if (sub === "/docs") {
    const docs = folder ? DOC_DIRS.flatMap((d) => markdownIn(folder, d)).slice(0, MAX_DOCS) : [];
    jsonResponse(res, 200, { folder: folder ?? null, docs }, req);
    return true;
  }
  const rel = url.searchParams.get("path") ?? "";
  const file = folder && /\.md$/i.test(rel) ? confineToDir(folder, rel) : null;
  if (!file) {
    jsonResponse(res, 404, { error: "No such document in this chat's project" }, req);
    return true;
  }
  try {
    jsonResponse(res, 200, { path: rel, text: readFileSync(file, "utf-8") }, req);
  } catch {
    jsonResponse(res, 404, { error: "No such document in this chat's project" }, req);
  }
  return true;
};
