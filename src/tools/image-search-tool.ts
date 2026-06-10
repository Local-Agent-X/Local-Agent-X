import type { ToolDefinition, ToolResult } from "../types.js";

/**
 * image_search — find DIRECT image URLs on the web so the agent can embed them
 * into documents/decks (the create-tools' `image` / `images` params fetch the
 * URL through the SSRF-hardened acquirer). Mirrors web_search's provider-chain
 * shape; falls through provider→provider on empty/error.
 *
 * Provider chain: Brave Images (if BRAVE_API_KEY) → DuckDuckGo → Wikimedia
 * Commons (keyless, license-clean — the always-available safety net).
 */

interface ImageHit { url: string; title: string; width: number; height: number; source: string }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36";
const enc = encodeURIComponent;

async function braveImages(query: string, max: number, apiKey: string, signal: AbortSignal): Promise<ImageHit[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${enc(query)}&count=${max}`, {
    headers: { "User-Agent": UA, Accept: "application/json", "X-Subscription-Token": apiKey }, signal,
  });
  const json = (await res.json()) as { results?: { title?: string; url?: string; thumbnail?: { src?: string }; properties?: { url?: string } }[] };
  return (json.results ?? []).slice(0, max).flatMap((r) => {
    const url = r.properties?.url ?? r.thumbnail?.src;
    return url ? [{ url, title: r.title ?? "", width: 0, height: 0, source: r.url ?? "brave" }] : [];
  });
}

async function ddgImages(query: string, max: number, signal: AbortSignal): Promise<ImageHit[]> {
  // DDG's image endpoint needs a `vqd` token minted by the HTML search page.
  const tokenRes = await fetch(`https://duckduckgo.com/?q=${enc(query)}&iax=images&ia=images`, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" }, signal,
  });
  const vqd = (await tokenRes.text()).match(/vqd=["']?([\d-]+)["']?/)?.[1];
  if (!vqd) return [];
  const res = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${enc(query)}&vqd=${vqd}&f=,,,&p=1`, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://duckduckgo.com/" }, signal,
  });
  const json = (await res.json()) as { results?: { image: string; title?: string; width?: number; height?: number; source?: string }[] };
  return (json.results ?? []).slice(0, max).map((r) => ({
    url: r.image, title: r.title ?? "", width: r.width ?? 0, height: r.height ?? 0, source: r.source ?? "duckduckgo",
  }));
}

async function wikimediaImages(query: string, max: number, signal: AbortSignal): Promise<ImageHit[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6` +
    `&gsrsearch=${enc(query)}&gsrlimit=${max}&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  const json = (await res.json()) as { query?: { pages?: Record<string, { title: string; imageinfo?: { url: string; width: number; height: number; mime: string }[] }> } };
  const pages = json.query?.pages ? Object.values(json.query.pages) : [];
  const out: ImageHit[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    // Only embeddable raster types — svg/tiff/pdf can't be embedded directly.
    if (!info || !/image\/(png|jpeg|gif|webp)/.test(info.mime)) continue;
    out.push({ url: info.url, title: p.title.replace(/^File:/, ""), width: info.width, height: info.height, source: "Wikimedia Commons" });
  }
  return out.slice(0, max);
}

type Provider = "brave" | "ddg" | "wikimedia";

async function run(p: Provider, q: string, max: number, key: string | undefined, signal: AbortSignal): Promise<ImageHit[]> {
  if (p === "brave") return key ? braveImages(q, max, key, signal) : [];
  if (p === "ddg") return ddgImages(q, max, signal);
  return wikimediaImages(q, max, signal);
}

function dedupe(hits: ImageHit[]): ImageHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => h.url && /^https?:\/\//i.test(h.url) && !seen.has(h.url) && seen.add(h.url));
}

function format(hits: ImageHit[]): string {
  if (!hits.length) return "No images found.";
  const lines = hits.map((h, i) => {
    const dims = h.width && h.height ? ` (${h.width}×${h.height})` : "";
    return `${i + 1}. ${h.url}${dims}${h.title ? ` — ${h.title}` : ""} [${h.source}]`;
  });
  return "Direct image URLs — to embed, pass one as the `source` of an `image` " +
    "(presentation slide) or `images` entry (document/pdf/spreadsheet):\n\n" + lines.join("\n");
}

export const imageSearchTool: ToolDefinition = {
  name: "image_search",
  description:
    "Search the web for IMAGES and get back direct image URLs. Use this when a document, " +
    "slide deck, or PDF would benefit from a relevant photo/diagram — find an image here, then " +
    "embed it by passing its URL as an image `source` to document_create / presentation_create / " +
    "pdf_create / spreadsheet_write. Prefer landscape, high-resolution results. Returns URLs with dimensions.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What the image should depict, e.g. 'modern office building exterior'" },
      max_results: { type: "number", description: "Max images to return (default 8, max 20)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { content: "Error: query is required.", isError: true };
    const max = Math.min(Math.max(Number(args.max_results) || 8, 1), 20);
    const timeout = AbortSignal.timeout(15_000);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const key = process.env.BRAVE_API_KEY;
    const chain: Provider[] = key ? ["brave", "ddg", "wikimedia"] : ["ddg", "wikimedia"];

    let lastErr = "";
    for (const p of chain) {
      try {
        const hits = dedupe(await run(p, query, max, key, merged));
        if (hits.length) return { content: format(hits.slice(0, max)), metadata: { provider: p, count: hits.length } };
      } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    }
    return { content: lastErr ? `Image search failed: ${lastErr}` : "No images found.", isError: !!lastErr };
  },
};

export const imageSearchToolEnhancements = {
  category: "web",
  tags: ["image", "images", "search", "photo", "picture", "web"],
  readOnly: true,
  concurrencySafe: true,
  searchHint: "search the web for images / photos to embed in documents",
};
