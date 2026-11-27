/**
 * A file outside the workspace that a device may open: a photo in Pictures, a PDF
 * in Downloads, named in a reply. Served at /local-files/<the full path, encoded>
 * to the operator (the phone, whose tunnel adds the operator token).
 *
 * The device reaches what the agent may read, no more (owner's call, 2026-11-26:
 * the agent can already read and move these files, so a phone that drives it
 * gains nothing from a narrower door). One rule, here:
 *   - the file gate the agent's own tools answer to (evaluateFileAccess, "read",
 *     under the user's File Access setting), so the phone's reach moves with it;
 *   - never a credential file (isSensitivePath), as /files refuses one;
 *   - only a document, picture, media file or zip: the address is on the UI's own
 *     origin, so nothing that runs there (a page, an SVG, a script) is served;
 *   - an existing file, exactly as named.
 * The resolver that names these in a reply (workspace/named-files.ts) and the
 * phone's path allowlist (broker-transport/device-paths.ts) read the same rule.
 */
import { realpathSync, statSync } from "node:fs";
import { sendFileOrRange } from "./byte-range.js";
import { basename, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../server-utils.js";
import { workspaceRoot } from "../config.js";
import { isSensitivePath } from "../data-lineage/index.js";
import { evaluateFileAccess, loadFileAccessMode } from "../security/layer/index.js";

export const LOCAL_FILES_PREFIX = "/local-files/";

/** What may be served, and how: shown in place (inline) or downloaded. */
const LOCAL_FILE_TYPES: Record<string, { type: string; inline: boolean }> = {
  png: { type: "image/png", inline: true }, jpg: { type: "image/jpeg", inline: true }, jpeg: { type: "image/jpeg", inline: true },
  gif: { type: "image/gif", inline: true }, webp: { type: "image/webp", inline: true },
  mp4: { type: "video/mp4", inline: true }, webm: { type: "video/webm", inline: true },
  mp3: { type: "audio/mpeg", inline: true }, wav: { type: "audio/wav", inline: true }, m4a: { type: "audio/mp4", inline: true }, ogg: { type: "audio/ogg", inline: true },
  pdf: { type: "application/pdf", inline: true }, txt: { type: "text/plain", inline: true }, md: { type: "text/plain", inline: true },
  csv: { type: "text/csv", inline: true }, json: { type: "application/json", inline: true },
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false }, doc: { type: "application/msword", inline: false },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false }, xls: { type: "application/vnd.ms-excel", inline: false },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", inline: false }, ppt: { type: "application/vnd.ms-powerpoint", inline: false },
  rtf: { type: "application/rtf", inline: false }, zip: { type: "application/zip", inline: false },
};

const extOf = (path: string): string => (basename(path).split(".").pop() ?? "").toLowerCase();

/** The address a device fetches a local file at. */
export function localFilesAddress(absPath: string): string {
  return LOCAL_FILES_PREFIX + encodeURIComponent(absPath);
}

/** Why a device may not open `absPath`, or null when it may. */
export function localFileRefusal(absPath: string): string | null {
  if (!isAbsolute(absPath) || absPath.includes("\x00")) return "not a full path";
  if (!(extOf(absPath) in LOCAL_FILE_TYPES)) return "not a document, picture or media file";
  if (isSensitivePath(absPath)) return "a credential file";
  let real: string;
  try {
    real = realpathSync.native(absPath);
    if (!statSync(real).isFile()) return "not a file";
  } catch { return "no such file"; }
  // A link named x.png that resolves to a key file or a page is held to the rule too.
  if (!(extOf(real) in LOCAL_FILE_TYPES) || isSensitivePath(real)) return "not a document, picture or media file";
  const gate = evaluateFileAccess(workspaceRoot(), loadFileAccessMode(), () => false, "read", real);
  return gate.allowed ? null : gate.reason;
}

/** GET /local-files/<encoded path>, after the caller checked the operator. */
export function serveLocalFile(url: URL, req: IncomingMessage, res: ServerResponse): void {
  let absPath: string;
  try { absPath = decodeURIComponent(url.pathname.slice(LOCAL_FILES_PREFIX.length)); } catch {
    jsonResponse(res, 400, { error: "Malformed path" }, req);
    return;
  }
  const refused = localFileRefusal(absPath);
  if (refused !== null) {
    jsonResponse(res, refused === "no such file" ? 404 : 403, { error: `Not served: ${refused}` }, req);
    return;
  }
  const served = LOCAL_FILE_TYPES[extOf(absPath)];
  const headers: Record<string, string> = { "Content-Type": served.type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache" };
  if (!served.inline) headers["Content-Disposition"] = `attachment; filename="${basename(absPath).replace(/["\\\r\n]/g, "_")}"`;
  // A video plays in pieces as it arrives (byte-range.ts).
  sendFileOrRange(req, res, realpathSync.native(absPath), headers);
}
