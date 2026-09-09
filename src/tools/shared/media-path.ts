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
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveAgentPath } from "../../workspace/paths.js";
import { getLaxDir } from "../../lax-data-dir.js";

export function resolveMediaPath(p: string): string {
  const resolved = resolveAgentPath(p);
  if (existsSync(resolved)) return resolved;
  const inUploads = join(getLaxDir(), "uploads", basename(p));
  return existsSync(inUploads) ? inUploads : resolved;
}
