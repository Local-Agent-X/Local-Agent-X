// How a browser view's id names the chat it belongs to. Read on both sides of
// the server↔desktop channel: the server attributes a view's requests and
// downloads to a session by it, and the desktop decides which chat's pane a
// view shows in by it.
//
// An AGENT view is minted `view-<sessionId>-shared` for a session's first tab
// and `view-<sessionId>-shared-tN` for its later ones (browser/instance.ts
// inAppViewId, browser/in-app-tabs.ts). A USER view's id (`foreground`,
// `home-…`, `user-N`) names no session: which chat it belongs to is on the
// desktop's record (BrowserViewInfo.ownerSessionId).

/** The session an agent view's id names, or undefined for any other id. The
 *  fixed `-shared` suffix makes the parse exact: a session id may itself
 *  contain hyphens. */
export function sessionIdFromViewId(viewId: unknown): string | undefined {
  if (typeof viewId !== "string" || !viewId.startsWith("view-")) return undefined;
  const rest = viewId.slice("view-".length).replace(/-t\d+$/, "");
  if (!rest.endsWith("-shared")) return undefined;
  const sessionId = rest.slice(0, -"-shared".length);
  return sessionId || undefined;
}
