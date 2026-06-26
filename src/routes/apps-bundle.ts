/**
 * App-bundle builder — produces the offline payload a paired phone downloads to
 * run an app with the desktop unreachable (product flow 5). Split out of
 * routes/apps.ts so that file stays under the 400-LOC cap; the route handler
 * delegates here.
 *
 * The bundle is NOT a new app model — it reuses the canonical surfaces:
 *   - registered apps  → HTML from app-renderer's renderApp() (self-contained:
 *     inline nonce'd style + client script, no external assets).
 *   - workspace HTML apps (workspace/apps/<id>/index.html) → the file the user's
 *     agent wrote, plus a manifest of the static assets it references, each
 *     inlined so the phone can serve them locally with no desktop round-trip.
 *   - state snapshot → AppRegistry.getState() (the same state.json the in-page
 *     client polls), so the phone's local adapter starts from the live state.
 *
 * Security: this runs under /api/apps, the narrow path scope the broker phone is
 * held to (see broker-transport/device-paths.ts). It never reads outside the
 * workspace app dir (confineToDir) and caps total inlined size so a huge app
 * can't blow the response.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { confineToDir } from "../security/file-access.js";
import { renderApp } from "../app-renderer/index.js";
import type { AppRegistry, AppState } from "../app-runtime/index.js";

/** One static file the phone must persist to run the app offline. */
export interface BundleFile {
  /** App-relative path, forward-slashed (e.g. "index.html", "css/app.css"). */
  path: string;
  /** File contents. Base64 when `encoding` is "base64", else raw UTF-8 text. */
  content: string;
  encoding: "utf-8" | "base64";
}

/** The complete offline payload for one app (mirrors mobile AppBundle). */
export interface AppBundlePayload {
  appId: string;
  /** App version (registry version, or index.html mtime for workspace apps). */
  version: string;
  /** Entry document the WebView loads offline. */
  entry: string;
  /** Every file the phone persists; `entry` is one of these. */
  files: BundleFile[];
  /** Live state snapshot, or null when the app has no registry state. */
  state: AppState | null;
}

// Keep a single download well-bounded — a bundle is meant for small agent-built
// apps, not arbitrarily large media trees. Past the cap we omit further assets
// (the HTML still loads; missing assets degrade, they don't break the download).
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const TEXT_EXTS = new Set(["html", "htm", "css", "js", "json", "svg", "txt", "md", "csv", "xml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "_audit"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Recursively collect bundle files under `dir`, staying within `appDir` and
 *  the byte cap. Text files are UTF-8; binaries are base64. */
function collectFiles(appDir: string, dir: string, prefix: string, acc: BundleFile[], budget: { used: number }): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) { collectFiles(appDir, abs, rel, acc, budget); continue; }
    if (!entry.isFile()) continue;
    // Symlink-safe containment — never follow a planted link out of the app dir.
    const safe = confineToDir(appDir, rel);
    if (!safe) continue;
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    if (budget.used + size > MAX_BUNDLE_BYTES) continue; // skip oversize, keep going
    try {
      const buf = readFileSync(abs);
      const text = TEXT_EXTS.has(extOf(entry.name));
      acc.push({
        path: rel,
        content: text ? buf.toString("utf-8") : buf.toString("base64"),
        encoding: text ? "utf-8" : "base64",
      });
      budget.used += size;
    } catch { /* unreadable file — skip, don't fail the whole bundle */ }
  }
}

/**
 * Build the offline bundle for `appId`, or null if the app exists in neither the
 * registry nor the workspace. Pure w.r.t. the filesystem + registry passed in,
 * so it's unit-testable without an HTTP server.
 */
export function buildAppBundle(
  appReg: AppRegistry,
  workspaceDir: string,
  appId: string,
  port: number,
): AppBundlePayload | null {
  const state = appReg.getState(appId);

  // Workspace HTML app takes precedence (mirrors the serve path in
  // request-handler.ts / routes.apps.ts: a custom index.html is what the user
  // built and expects to run).
  const appDir = resolve(workspaceDir, "apps", appId);
  const indexPath = resolve(appDir, "index.html");
  if (appDir.startsWith(resolve(workspaceDir, "apps")) && existsSync(indexPath)) {
    const files: BundleFile[] = [];
    collectFiles(appDir, appDir, "", files, { used: 0 });
    const hasEntry = files.some((f) => f.path === "index.html");
    if (!hasEntry) {
      // index.html existed but was skipped (e.g. over budget) — include it raw
      // so the bundle always has its entry document.
      try { files.unshift({ path: "index.html", content: readFileSync(indexPath, "utf-8"), encoding: "utf-8" }); }
      catch { return null; }
    }
    let version = "1";
    try { version = String(Math.floor(statSync(indexPath).mtimeMs)); } catch { /* keep default */ }
    return { appId, version, entry: "index.html", files, state };
  }

  // Registered app — render the self-contained HTML document.
  const def = appReg.get(appId);
  if (!def) return null;
  const html = renderApp(def, port);
  return {
    appId,
    version: String(def.version),
    entry: "index.html",
    files: [{ path: "index.html", content: html, encoding: "utf-8" }],
    state,
  };
}
