/**
 * Mission Marketplace API — install/list/search community missions.
 * Community missions are fetched from a registry and installed locally.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Mission } from "../missions.js";
import type { ToolDefinition } from "../types.js";
import { loadCustomMissions, saveCustomMissions } from "./builder.js";

const MARKETPLACE_REGISTRY_URL = "https://raw.githubusercontent.com/open-agent-x/mission-marketplace/main/registry.json";
const CACHE_PATH = join(homedir(), ".sax", "marketplace-cache.json");

interface MarketplaceEntry {
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  downloads: number;
  mission: Mission;
}

interface MarketplaceCache {
  entries: MarketplaceEntry[];
  fetchedAt: number;
}

function loadCache(): MarketplaceCache | null {
  if (existsSync(CACHE_PATH)) {
    try {
      const cache: MarketplaceCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
      const oneHour = 60 * 60 * 1000;
      if (Date.now() - cache.fetchedAt < oneHour) return cache;
    } catch {}
  }
  return null;
}

function saveCache(cache: MarketplaceCache): void {
  const dir = join(homedir(), ".sax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

export async function fetchRegistry(): Promise<MarketplaceEntry[]> {
  const cache = loadCache();
  if (cache) return cache.entries;

  try {
    const res = await fetch(MARKETPLACE_REGISTRY_URL);
    if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
    const entries = (await res.json()) as MarketplaceEntry[];
    saveCache({ entries, fetchedAt: Date.now() });
    return entries;
  } catch {
    return loadCache()?.entries ?? [];
  }
}

export function searchMissions(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  const q = query.toLowerCase();
  return entries.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.tags.some(t => t.toLowerCase().includes(q))
  );
}

export function installMission(entry: MarketplaceEntry): Mission {
  const missions = loadCustomMissions();
  const existing = missions.findIndex(m => m.name === entry.mission.name);
  if (existing >= 0) {
    missions[existing] = entry.mission;
  } else {
    missions.push(entry.mission);
  }
  saveCustomMissions(missions);
  return entry.mission;
}

export function createMarketplaceTools(): ToolDefinition[] {
  return [
    {
      name: "marketplace_search",
      description: "Search the mission marketplace for community-created missions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term (name, description, or tag)" },
        },
        required: ["query"],
      },
      async execute(args) {
        try {
          const entries = await fetchRegistry();
          const results = searchMissions(entries, String(args.query));
          if (results.length === 0) return { content: "No missions found matching your query." };
          const list = results.map(e =>
            `• **${e.name}** v${e.version} by ${e.author}\n  ${e.description}\n  Tags: ${e.tags.join(", ")} | Downloads: ${e.downloads}`
          ).join("\n\n");
          return { content: `Found ${results.length} mission(s):\n\n${list}` };
        } catch (e: any) {
          return { content: `Marketplace search failed: ${e.message}`, isError: true };
        }
      },
    },
    {
      name: "marketplace_install",
      description: "Install a mission from the marketplace.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Mission name to install" },
        },
        required: ["name"],
      },
      async execute(args) {
        try {
          const entries = await fetchRegistry();
          const entry = entries.find(e => e.name === String(args.name));
          if (!entry) return { content: `Mission "${args.name}" not found in marketplace.` };
          const mission = installMission(entry);
          return { content: `Installed "${mission.name}" with ${mission.steps.length} steps.` };
        } catch (e: any) {
          return { content: `Install failed: ${e.message}`, isError: true };
        }
      },
    },
    {
      name: "marketplace_list",
      description: "List all missions available in the marketplace.",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const entries = await fetchRegistry();
          if (entries.length === 0) return { content: "Marketplace is empty or unavailable." };
          const list = entries.map(e => `• **${e.name}** — ${e.description} (v${e.version})`).join("\n");
          return { content: `Marketplace missions (${entries.length}):\n\n${list}` };
        } catch (e: any) {
          return { content: `Failed to list marketplace: ${e.message}`, isError: true };
        }
      },
    },
  ];
}
