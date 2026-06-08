import type { ToolDefinition, ToolResult } from "../types.js";

interface SearchResult { title: string; url: string; snippet: string }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36";

async function searchDDG(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal,
  });
  const html = await res.text();
  const results: SearchResult[] = [];
  const blockRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < max) {
    const url = decodeURIComponent(m[1].replace(/.*uddg=/, "").replace(/&.*/, ""));
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
    results.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  return results;
}

async function searchBrave(query: string, max: number, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", "X-Subscription-Token": apiKey },
    signal,
  });
  const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
  return (json.web?.results ?? []).slice(0, max).map(r => ({ title: r.title, url: r.url, snippet: r.description }));
}

function formatResults(results: SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}

type Provider = "brave" | "ddg";

async function runProvider(p: Provider, query: string, max: number, braveKey: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
  if (p === "brave") return braveKey ? searchBrave(query, max, braveKey, signal) : [];
  return searchDDG(query, max, signal);
}

// Run one query down the provider chain, falling through to the next provider
// when one errors or returns nothing. Throws only if every provider errored.
async function searchOneQuery(query: string, max: number, chain: Provider[], braveKey: string | undefined, signal: AbortSignal): Promise<SearchResult[]> {
  let lastErr: unknown;
  for (const p of chain) {
    try {
      const r = await runProvider(p, query, max, braveKey, signal);
      if (r.length) return r;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// URL identity for dedup: drop fragment + trailing slash, lowercase host. Keeps
// the query string (distinct ?id= pages are distinct). Falls back to the raw
// string for unparseable URLs so they still collapse against exact dupes.
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url) continue;
    const key = canonicalUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the internet. Pass a single `query`, or several in `queries` to fan out and search them in parallel — results are merged and deduplicated. Returns titles, URLs, and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      queries: { type: "array", items: { type: "string" }, description: "Multiple queries to run in parallel (fan-out). Use for broad or deep research; results merge and dedupe by URL." },
      max_results: { type: "number", description: "Max results to return (default 8, max 20)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const single = String(args.query ?? "").trim();
    const multi = Array.isArray(args.queries) ? args.queries.map(q => String(q ?? "").trim()) : [];
    const queries = [...new Set([single, ...multi].filter(Boolean))];
    if (!queries.length) return { content: "Error: query is required.", isError: true };
    const max = Math.min(Math.max(Number(args.max_results) || 8, 1), 20);
    const timeout = AbortSignal.timeout(15_000);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const braveKey = process.env.BRAVE_API_KEY;
    const chain: Provider[] = braveKey ? ["brave", "ddg"] : ["ddg"];

    const settled = await Promise.allSettled(queries.map(q => searchOneQuery(q, max, chain, braveKey, merged)));
    const all: SearchResult[] = [];
    let anyFulfilled = false;
    let firstErr = "";
    for (const s of settled) {
      if (s.status === "fulfilled") { anyFulfilled = true; all.push(...s.value); }
      else if (!firstErr) firstErr = s.reason instanceof Error ? s.reason.message : String(s.reason);
    }
    if (!anyFulfilled) return { content: `Search failed: ${firstErr || "no results"}`, isError: true };
    return { content: formatResults(dedupeResults(all).slice(0, max)) };
  },
};

export const webSearchToolEnhancements = {
  category: "web",
  tags: ["search", "web", "internet", "google", "browse"],
  readOnly: true,
  concurrencySafe: true,
  searchHint: "search the web internet for information",
};
