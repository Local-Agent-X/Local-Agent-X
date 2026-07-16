/**
 * Per-session work-root anchor for IDE chat sessions.
 *
 * The App IDE tells the agent "Work in workspace/apps/<id>/" as a sentence in
 * the chat prefix (public/js/apps-ide-messaging.js → ideContextPrefix). That is
 * prose: nothing in the server ever learned which app the turn belonged to, so
 * every tool default still anchored to the PROJECT ROOT. Live failure
 * 2026-07-15: an IDE turn for `todo-app` ran glob("**\/*.css") with no `path`,
 * which falls back to `sessionWorkRootOf(sessionId) ?? process.cwd()`
 * (tools/glob-tool.ts) — the repo root — found LAX's OWN public/css/app.css as
 * the first hit, and edited the platform's stylesheet instead of the app's.
 *
 * Stamping the app's dir as the session work root fixes that at the seam the
 * three defaults already read: relative file paths (workspace/paths.ts →
 * resolveAgentPathFrom), bash's cwd (tool-execution/resolve-tool.ts), and
 * glob/grep's default search base all consult sessionWorkRootOf. One
 * registration moves all three onto the app.
 *
 * This is an ANCHOR, not a cage — deliberately. A work root changes where
 * RELATIVE paths land; absolute paths still resolve wherever they point, so an
 * agent that genuinely needs a file outside the app (reading a shared asset,
 * checking a config) can still reach it by naming it explicitly. Confining an
 * IDE session to its app dir would need a narrowing parameter threaded into
 * evaluateFileAccess, which does not exist (addAllowedPath only ever WIDENS
 * scope). Do not mistake this module for a security boundary.
 *
 * Mirrors session/project.ts: stamped from the WS frame on every chat message,
 * cleared when the frame carries no appId, so a session that leaves IDE mode
 * does not keep the anchor.
 */

import { existsSync } from "node:fs";
import { workspacePath } from "../config.js";
import { setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
import { createLogger } from "../logger.js";

const logger = createLogger("session.ide-work-root");

/**
 * App ids that may be turned into a directory. Same character class the app
 * file-serving route enforces (routes/apps.ts → /^\/api\/apps\/([a-zA-Z0-9_-]+)\//),
 * kept identical so the id that names a dir over HTTP and the id that anchors a
 * session can't diverge. The class admits no dot, slash, or backslash, so "..",
 * "a/../..", and absolute paths are rejected before they reach the filesystem —
 * appId arrives from the browser and is untrusted.
 */
const VALID_APP_ID = /^[a-zA-Z0-9_-]+$/;

/** The workspace dir for an app id, or null if the id isn't one we'd serve. */
export function ideAppDir(appId: unknown): string | null {
  if (typeof appId !== "string" || !VALID_APP_ID.test(appId)) return null;
  return workspacePath("apps", appId);
}

/**
 * Stamp (or clear) the IDE app work root for a session.
 *
 * Called from the WS chat router for EVERY chat frame. A frame with a valid
 * appId whose dir exists anchors the session; anything else clears, so the
 * anchor can never outlive the IDE session that set it or point somewhere the
 * agent's tools would only find an empty search.
 *
 * @returns the anchored dir, or null when the session was left unanchored.
 */
export function stampIdeWorkRoot(sessionId: string, appId: unknown): string | null {
  if (!sessionId) return null;

  if (appId === undefined || appId === null || appId === "") {
    clearSessionWorkRoot(sessionId);
    return null;
  }

  const dir = ideAppDir(appId);
  if (!dir) {
    // A non-conforming id is a client bug or an injection attempt, not a
    // routine miss — say so rather than silently falling back to the
    // repo-root default that caused the original wrong-file edit.
    logger.warn(`[ide-work-root] refusing malformed appId ${JSON.stringify(appId)} for sess=${sessionId}`);
    clearSessionWorkRoot(sessionId);
    return null;
  }

  if (!existsSync(dir)) {
    logger.warn(`[ide-work-root] app dir missing, leaving sess=${sessionId} unanchored: ${dir}`);
    clearSessionWorkRoot(sessionId);
    return null;
  }

  setSessionWorkRoot(sessionId, dir);
  return dir;
}
