import type { ToolDefinition, ToolResult } from "./types.js";

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

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the internet for information using a text query. Returns titles, URLs, and snippets from web results.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results to return (default 8)" },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (!query) return { content: "Error: query is required.", isError: true };
    const max = Math.min(Math.max(Number(args.max_results) || 8, 1), 20);
    const timeout = AbortSignal.timeout(15_000);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const braveKey = process.env.BRAVE_API_KEY;
      const results = braveKey
        ? await searchBrave(query, max, braveKey, merged)
        : await searchDDG(query, max, merged);
      return { content: formatResults(results) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Search failed: ${msg}`, isError: true };
    }
  },
};

export const webSearchToolEnhancements = {
  category: "web",
  tags: ["search", "web", "internet", "google", "browse"],
  readOnly: true,
  concurrencySafe: true,
  searchHint: "search the web internet for information",
};
