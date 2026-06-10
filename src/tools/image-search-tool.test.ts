import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { imageSearchTool } from "./image-search-tool.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => { delete process.env.BRAVE_API_KEY; }); // force ddg → wikimedia chain

function res(body: { text?: string; json?: unknown }): Response {
  return {
    ok: true, status: 200, statusText: "OK",
    text: async () => body.text ?? "",
    json: async () => body.json ?? {},
  } as unknown as Response;
}

describe("image_search", () => {
  it("returns deduped direct image URLs from DuckDuckGo", async () => {
    globalThis.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      if (url.includes("duckduckgo.com/i.js")) return res({ json: { results: [
        { image: "https://a.com/img1.png", title: "A", width: 800, height: 600, source: "a.com" },
        { image: "https://a.com/img1.png", title: "A dup", width: 800, height: 600, source: "a.com" },
        { image: "https://b.com/img2.jpg", title: "B", width: 1200, height: 800, source: "b.com" },
      ] } });
      if (url.includes("duckduckgo.com/")) return res({ text: '<script>vqd="4-12345"</script>' });
      return res({ json: {} });
    }) as any;

    const r = await imageSearchTool.execute({ query: "eiffel tower" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.provider).toBe("ddg");
    expect(r.metadata?.count).toBe(2); // dup collapsed
    expect(r.content).toContain("https://a.com/img1.png");
    expect(r.content).toContain("https://b.com/img2.jpg");
    expect(r.content).toContain("1200×800");
  });

  it("falls through to Wikimedia when DuckDuckGo yields nothing", async () => {
    globalThis.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      if (url.includes("commons.wikimedia.org")) return res({ json: { query: { pages: {
        "1": { title: "File:Tower.jpg", imageinfo: [{ url: "https://upload/tower.jpg", width: 1000, height: 1500, mime: "image/jpeg" }] },
        "2": { title: "File:Doc.pdf", imageinfo: [{ url: "https://upload/doc.pdf", width: 0, height: 0, mime: "application/pdf" }] }, // filtered
      } } } });
      if (url.includes("duckduckgo.com/")) return res({ text: "<html>no token here</html>" });
      return res({ json: {} });
    }) as any;

    const r = await imageSearchTool.execute({ query: "tower" });
    expect(r.metadata?.provider).toBe("wikimedia");
    expect(r.content).toContain("https://upload/tower.jpg");
    expect(r.content).not.toContain("doc.pdf"); // non-raster filtered out
  });

  it("rejects an empty query without fetching", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as any;
    const r = await imageSearchTool.execute({ query: "  " });
    expect(r.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces an error when every provider fails", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as any;
    const r = await imageSearchTool.execute({ query: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("network down");
  });
});
