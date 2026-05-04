/**
 * Project Catalog — static system-prompt section listing the user's known
 * projects/entities so the agent recognizes them on sight without needing
 * to call `search_past_sessions` first.
 *
 * Two sources merged:
 *   - workspace/apps/<slug>/ — built apps, sorted by recency
 *   - <memoryDir>/bank/entities/<slug>.md — durable entity pages
 *
 * Generic / system entries (agent, assistant, claude, none, example, …) are
 * filtered out — those aren't user projects.
 *
 * Cached for 60s so the per-turn cost is just a Map lookup. The system
 * prompt is in the static (cacheable) section so this list ALSO benefits
 * from prompt caching across turns — once warm it costs ~zero tokens.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_CATALOG_ENTRIES = 30;
const CACHE_TTL_MS = 60_000;

const SYSTEM_ENTITIES = new Set([
  "agent", "agentxos", "assistant", "claude", "example",
  "always", "none", "memory-consolidate", "open",
]);

interface CatalogEntry {
  name: string;
  source: "app" | "entity";
  /** App entry-file path so the agent can read it without guessing. */
  hint?: string;
}

interface CachedCatalog {
  text: string;
  expiresAt: number;
}

let cache: CachedCatalog | null = null;

export function getProjectCatalogSection(memoryDir: string): string {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.text;
  const text = buildCatalog(memoryDir);
  cache = { text, expiresAt: now + CACHE_TTL_MS };
  return text;
}

function buildCatalog(memoryDir: string): string {
  const apps = scanApps();
  const entities = scanEntities(memoryDir);

  // Merge — apps first (more concrete artifacts), then entities. De-dup by
  // slug since an app and an entity often share a name.
  const seen = new Set<string>();
  const merged: CatalogEntry[] = [];
  for (const e of [...apps, ...entities]) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    merged.push(e);
    if (merged.length >= MAX_CATALOG_ENTRIES) break;
  }

  if (merged.length === 0) return "";

  const lines = merged.map((e) => {
    if (e.source === "app") {
      return `- ${e.name}  (built app: workspace/apps/${e.name}/${e.hint ? "  → " + e.hint : ""})`;
    }
    return `- ${e.name}  (entity page: bank/entities/${e.name}.md)`;
  });

  return (
    `## Known Projects & Entities\n` +
    `These are the user's own projects, apps, and known entities — recognize them on sight without searching. ` +
    `If the user mentions one of these names (or a close variant), you already have prior context. ` +
    `Use \`memory_search\` / \`search_past_sessions\` / \`read\` to pull specifics — but you SHOULD already know these exist.\n\n` +
    lines.join("\n")
  );
}

function scanApps(): CatalogEntry[] {
  const appsDir = resolve(process.cwd(), "workspace", "apps");
  if (!existsSync(appsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(appsDir);
  } catch {
    return [];
  }

  const items: Array<{ name: string; mtime: number; hint?: string }> = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(appsDir, name);
    let isDir = false;
    let mtime = 0;
    try {
      const st = statSync(dir);
      isDir = st.isDirectory();
      mtime = st.mtimeMs;
    } catch {}
    if (!isDir) continue;
    let hint: string | undefined;
    for (const c of ["index.html", "app.html", "app.js", "main.js", "index.js"]) {
      try {
        if (existsSync(join(dir, c))) { hint = c; break; }
      } catch {}
    }
    items.push({ name, mtime, hint });
  }

  // Sort by mtime descending — most-recently-touched apps surface first.
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, MAX_CATALOG_ENTRIES).map((i) => ({
    name: i.name,
    source: "app" as const,
    hint: i.hint,
  }));
}

function scanEntities(memoryDir: string): CatalogEntry[] {
  const entitiesDir = join(memoryDir, "bank", "entities");
  if (!existsSync(entitiesDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(entitiesDir);
  } catch {
    return [];
  }

  const items: Array<{ name: string; mtime: number }> = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (SYSTEM_ENTITIES.has(slug)) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(entitiesDir, file)).mtimeMs;
    } catch {}
    items.push({ name: slug, mtime });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, MAX_CATALOG_ENTRIES).map((i) => ({
    name: i.name,
    source: "entity" as const,
  }));
}

export function invalidateProjectCatalogCache(): void {
  cache = null;
}
