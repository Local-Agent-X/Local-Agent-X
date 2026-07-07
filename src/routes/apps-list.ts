/**
 * Builds the Apps-grid list served by GET /api/apps.
 *
 * Three sources, in precedence order (first to claim an id wins):
 *   1. Registry apps      — ~/.lax/apps/<id>/def.json (LAX-native app definitions).
 *   2. Workspace HTML apps — workspace/apps/<id>/index.html with no registry def.
 *   3. Full-stack apps     — a workspace app with a persisted dev-server record
 *      but NEITHER a def.json NOR a root index.html (Next.js / Vite / a real
 *      backend). Without this pass those apps are invisible in the grid despite
 *      being fully built — their only on-disk marker is the dev-server record.
 *
 * Extracted from apps.ts so the three-pass logic is unit-testable at the seam
 * (a workspace dir + dev-server records → the surfaced list) without standing up
 * a full server context, and to keep apps.ts under the LOC cap.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppDefinition } from "../app-runtime/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.apps-list");

/** Default launcher glyph for an app with no explicit icon and no sidebar pin. */
export const DEFAULT_APP_ICON = "📦";

export interface AppListEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  components: number;
  layout: string;
  url: string;
  updatedAt: number;
  status: string;
  version: number;
  visibility: string;
  hasBackend: boolean;
}

export interface AppListDeps {
  /** Registered app definitions (~/.lax/apps). */
  listRegistry: () => AppDefinition[];
  /** True if this app id has a persisted dev-server record. */
  hasDevServer: (id: string) => boolean;
  /** All persisted dev-server records (appId is all this pass needs). */
  listDevServers: () => Array<{ appId: string }>;
  /** Sidebar pins, for icon fallback. */
  pins: Array<{ name: string; icon: string; url: string }>;
  /** Absolute path to workspace/apps. */
  wsAppsDir: string;
  /** Server port, for building app URLs. */
  port: number;
  /** now() for the stale-dir fallback; injectable so tests are deterministic. */
  now: () => number;
}

/** Title-case a folder slug: "ai-video-stitch-next" → "Ai Video Stitch Next". */
function slugToName(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export function buildAppList(deps: AppListDeps): AppListEntry[] {
  const { pins, wsAppsDir, port, now } = deps;

  // Icon precedence (so apps carry an icon without a pin): AppDefinition.icon
  // → a `.icon` sidecar the builder writes per app → a sidebar pin's emoji → 📦.
  const pinIcon = (id: string, name: string): string => {
    const bySlug = pins.find(p => new RegExp(`/apps/${id}(?:[/?#]|$)`).test(p.url || ""));
    const byName = pins.find(p => p.name.toLowerCase() === name.toLowerCase());
    return (bySlug?.icon || byName?.icon || "").trim();
  };
  const sidecarIcon = (id: string): string => {
    const p = join(wsAppsDir, id, ".icon");
    try { return existsSync(p) ? readFileSync(p, "utf-8").trim() : ""; } catch { return ""; }
  };
  const iconFor = (id: string, name: string, defIcon?: string): string =>
    (defIcon || "").trim() || sidecarIcon(id) || pinIcon(id, name) || DEFAULT_APP_ICON;

  // Pass 1: registry apps. hasBackend lets the UI show a "Restart backend"
  // control (one file stat per app).
  const list: AppListEntry[] = deps.listRegistry().map((d) => ({
    id: d.id, name: d.name, description: d.description,
    icon: iconFor(d.id, d.name, d.icon),
    components: d.components.length, layout: d.layout.type,
    url: `http://127.0.0.1:${port}/apps/${d.id}`,
    updatedAt: d.updatedAt, status: d.status, version: d.version,
    visibility: d.permissions?.visibility || "team",
    hasBackend: deps.hasDevServer(d.id),
  }));
  const seen = new Set(list.map(a => a.id));

  // Pass 2: workspace HTML apps (root index.html) not in the registry.
  if (existsSync(wsAppsDir)) {
    try {
      for (const d of readdirSync(wsAppsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === "_audit" || seen.has(d.name)) continue;
        const indexPath = join(wsAppsDir, d.name, "index.html");
        if (!existsSync(indexPath)) continue;
        const st = statSync(indexPath);
        const wsName = slugToName(d.name);
        seen.add(d.name);
        list.push({
          id: d.name, name: wsName,
          icon: iconFor(d.name, wsName),
          description: "HTML app", components: 1, layout: "custom",
          url: `http://127.0.0.1:${port}/apps/${d.name}/index.html`,
          updatedAt: st.mtimeMs, status: "active", version: 1, visibility: "team",
          hasBackend: deps.hasDevServer(d.name),
        });
      }
    } catch (e) { logger.warn("[apps] workspace scan error:", (e as Error).message); }
  }

  // Pass 3: full-stack apps — a dev-server record but no def.json and no root
  // index.html (skipped by both passes above). The workspace dir mtime is the
  // "updated" time; the folder name is the title. URL is the reverse-proxy
  // route with NO trailing slash: a Next.js app sets basePath: "/apps/<id>", and
  // Next 308-redirects the trailing-slash form to the no-slash canonical. That
  // redirect broke the desktop popup (it opened, hit the 308, and closed), so
  // the URL must be the no-slash form the app's basePath already matches.
  for (const rec of deps.listDevServers()) {
    if (seen.has(rec.appId)) continue;
    const appWsDir = join(wsAppsDir, rec.appId);
    if (!existsSync(appWsDir)) continue;  // record without a folder — stale, skip
    seen.add(rec.appId);
    let updatedAt = now();
    try { updatedAt = statSync(appWsDir).mtimeMs; } catch { /* keep now() */ }
    const fsName = slugToName(rec.appId);
    list.push({
      id: rec.appId, name: fsName,
      icon: iconFor(rec.appId, fsName),
      description: "Full-stack app", components: 1, layout: "custom",
      url: `http://127.0.0.1:${port}/apps/${rec.appId}`,
      updatedAt, status: "active", version: 1, visibility: "team",
      hasBackend: true,
    });
  }

  return list;
}
