/**
 * Path resolution for the media tools.
 *
 * send_image/send_video/send_file and the perception tools get a
 * model-supplied path that often names a file in ~/.lax/uploads (a screenshot,
 * or an incoming bridge photo/video/voice note) rather than the
 * workspace-anchored tree resolveAgentPath assumes — so a bare
 * "screen-123.jpg" resolved to the wrong folder and the call failed. Try the
 * standard resolution first; if the file isn't there, fall back to uploads by
 * basename. openValidatedRead still re-validates whichever path we return.
 *
 * The pre-dispatch gate judged resolveAgentPath(p, sessionId) — the same
 * resolver, with the same session, so a session anchored to a work root opens
 * the path that was gated. The uploads fallback is a path the gate never saw,
 * so it is judged here by the same file-access decision before it is returned.
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveAgentPath } from "../../workspace/paths.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { workspaceRoot } from "../../config.js";
import { evaluateFileAccess, loadFileAccessMode } from "../../security/layer/index.js";

export function resolveMediaPath(p: string, sessionId?: string): string {
  const resolved = resolveAgentPath(p, sessionId);
  if (existsSync(resolved)) return resolved;
  const inUploads = join(getLaxDir(), "uploads", basename(p));
  if (!existsSync(inUploads)) return resolved;
  const verdict = evaluateFileAccess(workspaceRoot(), loadFileAccessMode(), () => false, "read", inUploads, sessionId);
  if (!verdict.allowed) throw new Error(`${p} is ${inUploads}, which the file-access gate refused: ${verdict.reason}`);
  return inUploads;
}
