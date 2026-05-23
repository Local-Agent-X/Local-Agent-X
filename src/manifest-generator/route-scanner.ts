import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./paths.js";
import type { RouteEntry } from "./types.js";

export function scanApiRoutes(): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();

  const add = (method: string, path: string, description?: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path, description: description || `${method} ${path}` });
  };

  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) { walk(full); continue; }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      scanRouteFile(full, add);
    }
  };

  walk(join(ROOT, "src", "routes"));

  // server.ts may register routes via Express-style .METHOD("/path", handler).
  try {
    const serverContent = readFileSync(join(ROOT, "src", "server.ts"), "utf-8");
    const expressRegex = /\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`]*)["'`]/gi;
    let m;
    while ((m = expressRegex.exec(serverContent)) !== null) {
      add(m[1].toUpperCase(), m[2]);
    }
  } catch {}

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

// Routes in this codebase are dispatched by guards like:
//   if (method === "GET" && url.pathname === "/api/foo") { ... }
//   if (method === "POST" && url.pathname.match(/^\/api\/foo\/[^/]+$/)) { ... }
//   if (method === "GET" && url.pathname.startsWith("/api/foo/")) { ... }
// We pair each method check on a line with the pathname comparison on the same line.
function scanRouteFile(file: string, add: (m: string, p: string, d?: string) => void): void {
  let content: string;
  try { content = readFileSync(file, "utf-8"); } catch { return; }

  for (const line of content.split("\n")) {
    const methodMatch = line.match(/method\s*===\s*["'](GET|POST|PUT|PATCH|DELETE)["']/);
    if (!methodMatch) continue;
    const method = methodMatch[1];

    const exact = line.match(/url\.pathname\s*===\s*["'`](\/[^"'`]*)["'`]/);
    if (exact) { add(method, exact[1]); continue; }

    const startsWith = line.match(/url\.pathname\.startsWith\s*\(\s*["'`](\/[^"'`]*)["'`]/);
    if (startsWith) { add(method, `${startsWith[1]}*`); continue; }

    const matchExpr = line.match(/url\.pathname\.match\s*\(\s*\/(.+?)\/[gimsuy]*\s*\)/);
    if (matchExpr) {
      const path = regexSourceToPath(matchExpr[1]);
      if (path) add(method, path);
    }
  }
}

// Convert a route regex source like "^\/api\/agents\/[^/]+$" into "/api/agents/:id".
function regexSourceToPath(src: string): string | null {
  let path = src;
  if (path.startsWith("^")) path = path.slice(1);
  if (path.endsWith("$")) path = path.slice(0, -1);
  path = path.replace(/\\\//g, "/");
  path = path.replace(/\[\^\/\]\+/g, ":id");
  path = path.replace(/\[a-zA-Z0-9_-\]\+/g, ":id");
  path = path.replace(/\([^)]+\)/g, ":id");
  path = path.replace(/\\\?/g, "?");
  if (!path.startsWith("/")) return null;
  return path;
}
