// Decide whether a window-open URL should go to the system browser. Pure (no
// electron import) so it's unit-testable without spinning up Electron.

/**
 * True when the URL should open in the user's default browser rather than be
 * handled inside the app. Classify by HOSTNAME, never a substring: an OAuth
 * authorize URL (e.g. accounts.x.ai) carries a loopback
 * `redirect_uri=http://127.0.0.1:.../callback` in its query, so a naive
 * `includes("127.0.0.1")` misreads it as local and the sign-in page never opens.
 */
export function isExternalBrowserUrl(rawUrl: string): boolean {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const h = parsed.hostname;
  return h !== "127.0.0.1" && h !== "localhost" && h !== "::1";
}
