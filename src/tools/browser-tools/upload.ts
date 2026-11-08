/**
 * upload — a local file into the page's file chooser, by ref.
 *
 * The file is a send: it leaves the machine for the site the page is on. So
 * before a byte moves, the call has been judged three ways, all keyed on the
 * browser row's `pathArgs` (tool-policy/tool-policies.network.ts):
 *   - the file-access gate confined `path`/`paths` as a read (workspace /
 *     common / unrestricted, sensitive patterns, vault and at-rest secrets);
 *   - the egress guard scanned them as the call's attachments — a
 *     credential-shaped name or secret-shaped contents put the call to the
 *     user as an approval card (the page is a destination they are watching),
 *     refused it when nobody was watching, and refused one of LAX's own
 *     data-dir files outright (tool-execution/egress-gates.ts probeEgressGuard);
 *   - the private-content gate counted each as a document sent to the page's
 *     site, and the kernel judged `upload` a write (PAGE_WRITE_ACTIONS).
 * This handler canonicalizes the paths the way that gate did (so the file
 * handed to the browser is the inode that was judged), refuses anything that
 * is not a regular file, and runs the attachment scan once more beside the
 * hand-off, as http_request re-checks its own body. The backend only delivers
 * the files (backend.ts uploadByRef).
 */

import { statSync } from "node:fs";
import type { ToolResult } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { BrowserBackend } from "../../browser/index.js";
import { canonicalizeAttachmentPath, checkAttachmentPaths } from "../http-egress-guard.js";
import { blocked } from "../result-helpers.js";
import { ok, err } from "./shared.js";

/** What the model is told when a file is refused outright (one of LAX's own
 *  data-dir files, or a credential file with nobody watching): the route is
 *  the human, never a workaround. */
export const UPLOAD_REFUSED_RECOVERY =
  "This file is not the agent's to upload. If the site needs it, " +
  "ask the user to attach it themselves in the co-driven browser, then continue.";

/** The files an upload call names: `paths` when given, else `path`. Every
 *  entry must be a non-empty string; anything else is refused in words. */
export function uploadPathsOf(args: Record<string, unknown>): string[] | { error: string } {
  if (args.paths !== undefined && args.paths !== null) {
    if (!Array.isArray(args.paths) || !args.paths.every((p): p is string => typeof p === "string" && p.trim() !== "")) {
      return { error: "'paths' must be an array of file paths (non-empty strings)." };
    }
    if (args.paths.length > 0) return args.paths;
  }
  if (typeof args.path === "string" && args.path.trim() !== "") return [args.path];
  return [];
}

export async function handleUpload(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<ToolResult> {
  if (args.ref === undefined || args.ref === null) {
    return err("'ref' (from snapshot) is required for upload — the file input, or the button/drop zone that opens the picker.");
  }
  const ref = Number(args.ref);
  if (isNaN(ref)) return err("'ref' must be a number from the snapshot.");
  const named = uploadPathsOf(args);
  if (!Array.isArray(named)) return err(named.error);
  if (named.length === 0) return err("Provide 'path' (one local file) or 'paths' (several) for upload.");

  const files: string[] = [];
  for (const p of named) {
    let real: string;
    try {
      real = canonicalizeAttachmentPath(p, sessionId);
    } catch (e) {
      return err(`Cannot upload ${p}: ${(e as Error).message}`);
    }
    let regular = false;
    try {
      regular = statSync(real).isFile();
    } catch {
      return err(`Cannot upload ${p}: no such file.`);
    }
    if (!regular) return err(`Cannot upload ${p}: not a regular file (a folder cannot go into a file chooser).`);
    files.push(real);
  }

  // Same check the egress gate ran before dispatch, on the canonical inodes
  // the browser will open. A confirmable finding (the user's own credential
  // file) was put to the user by that gate before this ran, and an unattended
  // run never got here, so only a hard finding (one of LAX's own data-dir
  // files) is this check's to refuse — as http_request treats its own re-scan.
  const guard = checkAttachmentPaths("browser upload", files, sessionId, { userMayVouch: true });
  if (guard && !guard.confirmable) {
    return blocked(guard.message, { layer: "egress-guard", recovery: UPLOAD_REFUSED_RECOVERY, userHint: USER_HINTS.outboundContent, ...guard.meta });
  }

  const result = await manager.uploadByRef(ref, files);
  return result.ok ? ok(result.text) : err(result.text);
}
