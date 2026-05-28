/**
 * Protocol Marketplace API — install/list/search community protocols.
 * Community protocols are fetched from a registry and installed locally.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Protocol } from "../protocols/index.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { ToolDefinition } from "../types.js";
import { loadCustomProtocols, saveCustomProtocols } from "./builder.js";

const MARKETPLACE_REGISTRY_URL = "https://raw.githubusercontent.com/local-agent-x/protocol-marketplace/main/registry.json";
const CACHE_PATH = join(getLaxDir(), "marketplace-cache.json");

interface MarketplaceEntry {
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  downloads: number;
  protocol: Protocol;
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
  const dir = getLaxDir();
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

export function searchProtocols(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  const q = query.toLowerCase();
  return entries.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.tags.some(t => t.toLowerCase().includes(q))
  );
}

export function installProtocol(entry: MarketplaceEntry): Protocol {
  const protocols = loadCustomProtocols();
  const existing = protocols.findIndex(m => m.name === entry.protocol.name);
  if (existing >= 0) {
    protocols[existing] = entry.protocol;
  } else {
    protocols.push(entry.protocol);
  }
  saveCustomProtocols(protocols);
  return entry.protocol;
}

export function createMarketplaceTools(): ToolDefinition[] {
  return [
    {
      name: "marketplace_search",
      description: "Search the protocol marketplace for community-created protocols.",
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
          const results = searchProtocols(entries, String(args.query));
          if (results.length === 0) return { content: "No protocols found matching your query." };
          const list = results.map(e =>
            `• **${e.name}** v${e.version} by ${e.author}\n  ${e.description}\n  Tags: ${e.tags.join(", ")} | Downloads: ${e.downloads}`
          ).join("\n\n");
          return { content: `Found ${results.length} protocol(s):\n\n${list}` };
        } catch (e: any) {
          return { content: `Marketplace search failed: ${e.message}`, isError: true };
        }
      },
    },
    {
      name: "marketplace_install",
      description: "Install a protocol from the marketplace.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name to install" },
        },
        required: ["name"],
      },
      async execute(args) {
        try {
          const entries = await fetchRegistry();
          const entry = entries.find(e => e.name === String(args.name));
          if (!entry) return { content: `Protocol not found in marketplace.` };
          const protocol = installProtocol(entry);
          return { content: `Installed "${protocol.name}" with ${protocol.steps.length} steps.` };
        } catch (e: any) {
          return { content: `Install failed: ${e.message}`, isError: true };
        }
      },
    },
    {
      name: "marketplace_list",
      description: "List all protocols available in the marketplace.",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const entries = await fetchRegistry();
          if (entries.length === 0) return { content: "Marketplace is empty or unavailable." };
          const list = entries.map(e => `• **${e.name}** — ${e.description} (v${e.version})`).join("\n");
          return { content: `Marketplace protocols (${entries.length}):\n\n${list}` };
        } catch (e: any) {
          return { content: `Failed to list marketplace: ${e.message}`, isError: true };
        }
      },
    },
  ];
}
