/**
 * How LAX serves a workspace app's static files — the response HEADERS and the
 * request-path → file RESOLUTION, in ONE definition shared by everything that
 * RESOLVES AN APP REQUEST: the `/apps/<id>/…` route (workspace-app-serving.ts)
 * and the app_build smoke gate's origin (app-build-smoke-origin.ts).
 *
 * Not everything that touches an app's files is a request resolver. Notably
 * `src/routes/apps-bundle.ts` picks the same dist/-then-source-`index.html`
 * entry when it packs an app for the phone's OFFLINE runtime — no request, no
 * headers, its own budget/encoding rules. That is a different concern, not a
 * fork of this one, but a reader changing the precedence here should know it
 * exists.
 *
 * Both used to be inline in workspace-app-serving.ts. That made the app_build
 * smoke gate structurally unable to check either: the gate loaded static builds
 * from `file://`, where there is no CSP and no route shape at all, so it
 * observed a render the user could never get and a static source scan had to
 * stand in for the missing evidence. The gate now serves the build from a local
 * origin using THESE headers and THIS resolver (app-build-smoke-origin.ts), so
 * a refusal or a missing asset is observed rather than guessed — and because
 * both sides read this module, the gate cannot drift from what the server does.
 *
 * Imports only node:fs/path + confineToDir, all of which the server route and
 * the build gate already depend on: neither subsystem is dragged into the other.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { confineToDir } from "../security/layer/index.js";

/** Content-Security-Policy for a served workspace app's HTML document.
 *  `connect-src` deliberately admits loopback on any port: apps legitimately
 *  call their own dev server / local sidecars. Everything else off-origin is
 *  refused, which is why an app that needs a remote API cannot work here. */
const WORKSPACE_APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'";

/** Security + cache headers sent with a served app's HTML (not with its assets —
 *  the policy that governs a page comes from the document response). */
export const WORKSPACE_APP_HTML_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": WORKSPACE_APP_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  "Cache-Control": "no-cache, must-revalidate",
  "Pragma": "no-cache",
});

/** Extension → Content-Type for app files. */
export const APP_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html", css: "text/css", js: "application/javascript", json: "application/json",
  png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", webp: "image/webp",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", woff: "font/woff", woff2: "font/woff2",
  map: "application/json", wasm: "application/wasm", txt: "text/plain",
});

/** Outcome of resolving one app request path to a file on disk. */
export type AppFileResolution =
  | { kind: "file"; path: string }
  | { kind: "forbidden" }
  | { kind: "not-found" };

/**
 * Resolve an app-relative request path to a servable file, exactly the way the
 * `/apps/<id>/…` route does.
 *
 * @param serveRoot     directory the app is served out of — a finished build's
 *                      `dist/` (see {@link staticBuildDistDir}) or the app dir.
 * @param servePathname request path relative to the app's mount point.
 * @param spaFallback   route an extensionless miss to `index.html`. True only
 *                      for a built dist/, where client-side routing owns URLs.
 */
export function resolveAppStaticFile(
  serveRoot: string, servePathname: string, spaFallback: boolean,
): AppFileResolution {
  let file = confineToDir(serveRoot, "." + servePathname);
  if (!file) return { kind: "forbidden" };
  try {
    if (existsSync(file) && statSync(file).isDirectory()) {
      const index = confineToDir(serveRoot, join(file, "index.html"));
      if (index && existsSync(index)) file = index;
    }
  } catch { /* stat race → the existence checks below still decide */ }
  if (spaFallback && !existsSync(file) && !/\.[a-z0-9]+$/i.test(servePathname)) {
    const index = confineToDir(serveRoot, "index.html");
    if (index) file = index;
  }
  if (!existsSync(file)) return { kind: "not-found" };
  // A directory with no index.html. Reading it throws EISDIR from inside the
  // request listener, which writes NO response at all and leaves the socket
  // hanging until the client's own timeout. "Not found" is the honest answer,
  // and it is the answer a caller without a crash guard needs.
  try { if (statSync(file).isDirectory()) return { kind: "not-found" }; } catch { return { kind: "not-found" }; }
  return { kind: "file", path: file };
}
