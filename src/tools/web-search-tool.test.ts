// web_search seam tests: provider fallback (Brave errors → DDG) and fan-out
// dedup (overlapping URLs across queries collapse to one). Both exercise the
// real execute() path with a mocked global fetch — no network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectArgViolations } from "../tool-execution/arg-validation.js";
import { webSearchTool, dedupeResults, canonicalUrl } from "./web-search-tool.js";

function ddgHtml(items: { url: string; title: string; snippet: string }[]): string {
  return items
    .map(
      i =>
        `<a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(i.url)}&rut=x">${i.title}</a>` +
        `<a class="result__snippet" href="#">${i.snippet}</a>`,
    )
    .join("\n");
}

function braveJson(items: { url: string; title: string; description: string }[]) {
  return { web: { results: items } };
}

const origFetch = globalThis.fetch;
const origKey = process.env.BRAVE_API_KEY;

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = origKey;
  vi.restoreAllMocks();
});

describe("canonicalUrl", () => {
  it("collapses trailing slash, fragment, and host case", () => {
    expect(canonicalUrl("https://Example.com/path/#frag")).toBe(canonicalUrl("https://example.com/path"));
  });
  it("keeps distinct query strings distinct", () => {
    expect(canonicalUrl("https://x.com/a?id=1")).not.toBe(canonicalUrl("https://x.com/a?id=2"));
  });
});

describe("dedupeResults", () => {
  it("removes same-URL duplicates that differ only by fragment/slash", () => {
    const out = dedupeResults([
      { title: "A", url: "https://x.com/p", snippet: "" },
      { title: "A dup", url: "https://x.com/p/#section", snippet: "" },
      { title: "B", url: "https://y.com/q", snippet: "" },
    ]);
    expect(out.map(r => r.title)).toEqual(["A", "B"]);
  });
});

describe("web_search execute", () => {
  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
  });

  it("falls back to DDG when Brave errors", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("brave.com")) throw new Error("brave 429");
      return new Response(ddgHtml([{ url: "https://fallback.com/a", title: "Fallback", snippet: "via ddg" }]), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const res = await webSearchTool.execute({ query: "anything" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("https://fallback.com/a");
    expect(res.content).toContain("Fallback");
  });

  it("fans out multiple queries and dedupes overlapping URLs", async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      // q1 and q2 both surface the shared URL; only q2 has the unique one.
      const shared = { url: "https://shared.com/x", title: "Shared", snippet: "s" };
      const body = url.includes("q2")
        ? ddgHtml([shared, { url: "https://only2.com/y", title: "Only2", snippet: "u" }])
        : ddgHtml([shared]);
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    const res = await webSearchTool.execute({ query: "q1", queries: ["q1", "q2"], max_results: 10 });
    expect(res.isError).toBeFalsy();
    const sharedCount = (res.content.match(/shared\.com/g) || []).length;
    expect(sharedCount).toBe(1);
    expect(res.content).toContain("only2.com");
  });

  it("accepts queries without a redundant query field", async () => {
    const schema = webSearchTool.parameters as {
      properties: Record<string, { type?: string; enum?: unknown[] }>;
      required: string[];
    };
    expect(collectArgViolations({ queries: ["q1", "q2"] }, schema)).toEqual([]);

    globalThis.fetch = vi.fn(async (input: unknown) => {
      const query = new URL(String(input)).searchParams.get("q");
      return new Response(ddgHtml([{ url: `https://${query}.example/result`, title: String(query), snippet: "ok" }]), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const res = await webSearchTool.execute({ queries: ["q1", "q2"] });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("q1.example");
    expect(res.content).toContain("q2.example");
  });

  it("rejects empty input at runtime", async () => {
    const res = await webSearchTool.execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("query or queries is required");
  });

  it("errors only when every query fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res = await webSearchTool.execute({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("network down");
  });
});
