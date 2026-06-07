import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspacePath } from "../../../config.js";

const STOP = new Set(["the", "and", "for", "app", "site", "page", "what", "where"]);
const ENTRY_CANDIDATES = ["index.html", "app.html", "app.js", "main.js", "index.js"];

export function findMatchingApps(query: string): Array<{ name: string; entryFile?: string }> {
  if (!query || query.length < 3) return [];
  const appsDir = workspacePath("apps");
  if (!existsSync(appsDir)) return [];

  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  if (tokens.length === 0) return [];

  const matches: Array<{ name: string; entryFile?: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(appsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    let isDir = false;
    try { isDir = statSync(join(appsDir, name)).isDirectory(); } catch {}
    if (!isDir) continue;
    const lowerName = name.toLowerCase();
    if (!tokens.some((t) => lowerName.includes(t))) continue;

    let entryFile: string | undefined;
    for (const candidate of ENTRY_CANDIDATES) {
      try {
        if (existsSync(join(appsDir, name, candidate))) { entryFile = candidate; break; }
      } catch {}
    }
    matches.push({ name, entryFile });
    if (matches.length >= 8) break;
  }
  return matches;
}
