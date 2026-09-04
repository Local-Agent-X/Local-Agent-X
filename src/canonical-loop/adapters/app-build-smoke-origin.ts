/**
 * Local HTTP origin for the static-build smoke gate.
 *
 * The gate used to load a finished static build from `file://`. At that scheme
 * the document has an opaque origin, NO Content-Security-Policy, and no route
 * shape: a cross-origin `fetch` the served app can never make succeeded during
 * the smoke, and a root-absolute `<script src="/main.js">` resolved off the
 * filesystem root instead of 404ing. The gate observed a page the user could
 * never get. This serves the same files over http at the SAME path shape
 * (`/apps/<id>/`) with the SAME headers (app-serving-policy.ts) and the SAME
 * request→file resolution (`resolveAppStaticFile`) workspace-app-serving.ts
 * uses, so the browser enforces the real policy and a refusal or a missing
 * asset becomes evidence instead of a guess.
 *
 * Scope, stated honestly — where this still differs from the real route:
 *   - It does not inject the connector-token isolation script (that mints a
 *     capability a build gate has no business minting). CSP is unaffected:
 *     'unsafe-inline' admits the script either way.
 *   - A path outside `/apps/<id>/` 404s here; production falls through to
 *     LAX's own public assets, which could coincidentally answer 200. Either
 *     way the app does not get its own file, which is the thing under test.
 *   - Confinement is to the app dir, where production confines to the whole
 *     workspace. An app reaching into a SIBLING app is 403 here and served
 *     there — stricter, and not a shape any build should rely on.
 *
 * OUT OF SCOPE (predates this module, parked as a product decision): when no
 * chromium can launch the gate reports "skipped" and the build ships
 * unverified. Whether a box with no browser may build apps at all is not a
 * question this file gets to answer.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AddressInfo } from "node:net";
import { staticBuildDistDir } from "../../tools/app-run-target.js";
import { APP_CONTENT_TYPES, WORKSPACE_APP_HTML_HEADERS, resolveAppStaticFile } from "../../server/app-serving-policy.js";

export interface SmokeOrigin {
  /** URL to navigate to — `/apps/<id>/`, the same mount point production uses. */
  url: string;
  close: () => Promise<void>;
}

/**
 * Directory the gate's origin will serve `appDir` out of: a finished build's
 * `dist/` when a run-target manifest says so, else the app dir itself. Same
 * choice serveWorkspaceApp makes — exported so the gate's "is there a page at
 * all?" pre-check asks about the file the browser will actually load.
 */
export function staticSmokeServeRoot(appDir: string): string {
  return staticBuildDistDir(appDir) ?? appDir;
}

/**
 * Serve `appDir` on an ephemeral loopback port under the workspace-app serving
 * policy, mounted at `/apps/<basename>/`. Bound to 127.0.0.1 only — the port is
 * open for the life of one smoke and must not be reachable off the box. Caller
 * MUST call `close()`.
 */
export async function startStaticSmokeOrigin(appDir: string): Promise<SmokeOrigin> {
  const appId = basename(appDir);
  const distDir = staticBuildDistDir(appDir);
  const serveRoot = distDir ?? appDir;
  const mount = `/apps/${appId}`;
  const server = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400); res.end(); return;
    }
    // Production only serves under /apps/<id>/; anything else never reaches the
    // app's files. Reproducing that is the whole point of the mount prefix — a
    // build using root-absolute asset paths must break HERE, not at the user.
    if (pathname !== mount && !pathname.startsWith(mount + "/")) { res.writeHead(404); res.end(); return; }
    const servePathname = pathname.slice(mount.length) || "/";
    const resolved = resolveAppStaticFile(serveRoot, servePathname, distDir !== null);
    if (resolved.kind === "forbidden") { res.writeHead(403); res.end(); return; }
    if (resolved.kind === "not-found") { res.writeHead(404); res.end(); return; }
    const ext = resolved.path.split(".").pop() || "";
    const headers: Record<string, string> = { "Content-Type": APP_CONTENT_TYPES[ext] || "application/octet-stream" };
    // Assets carry no policy headers, exactly as the real route serves them:
    // the CSP that governs the page comes from the document response.
    if (ext === "html") Object.assign(headers, WORKSPACE_APP_HTML_HEADERS);
    let body: Buffer;
    try {
      body = readFileSync(resolved.path);
    } catch (e) {
      // Unreadable despite existing (permissions, deleted mid-request). Answer
      // 500 — this listener has no crash guard, and a throw here would write no
      // response and hang the smoke to its full load budget.
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end((e as Error).message);
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    const onBindError = (e: Error) => reject(e);
    server.once("error", onBindError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onBindError);
      // Past bind, a socket-level error must not become an unhandled 'error'
      // event (which would take the process down mid-build). The smoke's own
      // load result is the verdict.
      server.on("error", () => {});
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}${mount}/`, close: () => closeServer(server) };
}

/** Close the listener and drop keep-alive sockets the headless browser left
 *  open — without closeAllConnections() the close callback never fires and the
 *  gate would hang after an otherwise successful smoke. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
