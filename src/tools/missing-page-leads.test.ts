import { describe, expect, it, afterEach, vi } from "vitest";

const undiciMock = vi.hoisted(() => ({
  handler: null as null | ((url: string, opts: unknown) => unknown),
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (url: unknown, opts?: unknown) =>
      undiciMock.handler ? undiciMock.handler(String(url), opts) : actual.fetch(url as never, opts as never),
  };
});

const {
  ancestorUrls,
  extractSameOriginLinks,
  formatMissingPageLeads,
  gatherMissingPageLeads,
  scoreLead,
} = await import("./missing-page-leads.js");
const { webFetchTool, createHttpRequestTool } = await import("./web-tools.js");

function fakeResponse(status: number, body = "", type = "text/html; charset=utf-8") {
  return {
    status,
    statusText: status === 404 ? "Not Found" : "",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => (k.toLowerCase() === "content-type" ? type : null),
      forEach: (cb: (v: string, k: string) => void) => cb(type, "content-type"),
    },
    text: async () => body,
  };
}

/** A tiny site: a URL → [status, html] table; everything else is a bare 404. */
function serveSite(pages: Record<string, string>, notFoundBody = "not found") {
  const seen: string[] = [];
  undiciMock.handler = (url) => {
    seen.push(url);
    const key = url.replace(/\/$/, "");
    return key in pages ? fakeResponse(200, pages[key]) : fakeResponse(404, notFoundBody);
  };
  return seen;
}

afterEach(() => { undiciMock.handler = null; });

describe("missing-page-leads — pieces", () => {
  it("lists parent pages nearest first, ending at the site root", () => {
    expect(ancestorUrls("https://docs.example/docs/v2/limits?x=1")).toEqual([
      "https://docs.example/docs/v2",
      "https://docs.example/docs",
      "https://docs.example/",
    ]);
  });

  it("keeps only same-origin links, resolved and de-duplicated", () => {
    const html = `<a href="/docs/v3/rate-limits">Rate <b>limits</b></a>
      <a href="https://other.example/x">Elsewhere</a>
      <a href="/docs/v3/rate-limits#burst">Rate limits again</a>
      <a href='v3/webhooks'>Webhooks &amp; events</a>`;
    expect(extractSameOriginLinks(html, "https://docs.example/docs/")).toEqual([
      { url: "https://docs.example/docs/v3/rate-limits", text: "Rate limits" },
      { url: "https://docs.example/docs/v3/webhooks", text: "Webhooks & events" },
    ]);
  });

  it("ranks by the missing page's own name above its section", () => {
    const missing = "https://docs.example/docs/v2/limits";
    const rate = scoreLead(missing, { url: "https://docs.example/docs/v3/rate-limits", text: "Rate limits" });
    const hooks = scoreLead(missing, { url: "https://docs.example/docs/v3/webhooks", text: "Webhooks" });
    expect(rate).toBeGreaterThan(hooks);
  });
});

describe("gatherMissingPageLeads", () => {
  const fetcherFor = (pages: Record<string, string>) => {
    const asked: string[] = [];
    return {
      asked,
      fetchPage: async (url: string) => { asked.push(url); return pages[url] ?? null; },
    };
  };

  it("finds a moved page through the parent index and stops there", async () => {
    const { asked, fetchPage } = fetcherFor({
      "https://docs.example/docs": `<a href="/docs/v3/authentication">Authentication</a><a href="/docs/v3/rate-limits">Rate limits</a>`,
    });
    const result = await gatherMissingPageLeads("https://docs.example/docs/v2/limits", null, fetchPage);
    expect(result.leads[0].url).toBe("https://docs.example/docs/v3/rate-limits");
    expect(asked).toEqual(["https://docs.example/docs/v2", "https://docs.example/docs"]);
  });

  it("uses the 404 page's own navigation without fetching anything", async () => {
    const { asked, fetchPage } = fetcherFor({});
    const notFound = `<nav><a href="/history/incidents/march-2024-outage">March 2024 outage</a><a href="/">Home</a></nav>`;
    const result = await gatherMissingPageLeads("https://status.example/status/incidents/2024-03-outage", notFound, fetchPage);
    expect(result.leads[0].url).toBe("https://status.example/history/incidents/march-2024-outage");
    expect(asked).toEqual([]);
  });

  it("falls back to listing the nearest index when nothing matches by name", async () => {
    const { fetchPage } = fetcherFor({
      "https://handbook.example/": `<a href="/finance">Finance</a><a href="/people">People</a>`,
    });
    const result = await gatherMissingPageLeads("https://handbook.example/2023/travel", null, fetchPage);
    expect(result.leads.map((l) => l.text)).toEqual(["Finance", "People"]);
    expect(formatMissingPageLeads(result)).toContain("No link matched");
  });

  it("returns nothing when the site offers no links at all", async () => {
    const result = await gatherMissingPageLeads("https://x.example/a/b", "not found", async () => null);
    expect(formatMissingPageLeads(result)).toBe("");
  });
});

describe("web tools hand back leads for a missing page", () => {
  const site = {
    "https://docs.example/docs": `<h1>Docs</h1><a href="/docs/v3/rate-limits">Rate limits</a><a href="/docs/v3/webhooks">Webhooks</a>`,
  };

  it("web_fetch: a 404 carries the replacement page instead of 'try web_search'", async () => {
    const seen = serveSite(site);
    const res = await webFetchTool.execute({ url: "https://docs.example/docs/v2/limits" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("https://docs.example/docs/v3/rate-limits");
    expect(res.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(res.content).not.toContain("web_search");
    expect(seen.every((u) => u.startsWith("https://docs.example/"))).toBe(true);
  });

  it("web_fetch: keeps the generic hint when the site has no leads", async () => {
    serveSite({});
    const res = await webFetchTool.execute({ url: "https://docs.example/docs/v2/limits" });
    expect(res.content).toContain("web_search");
  });

  it("http_request GET: appends the same leads to the 404 body", async () => {
    serveSite(site);
    const res = await createHttpRequestTool().execute({ url: "https://docs.example/docs/v2/limits" });
    expect(res.content).toContain("HTTP 404");
    expect(res.content).toContain("https://docs.example/docs/v3/rate-limits");
  });

  it("http_request: a 404 from a mutation is an API answer — no parent fetches", async () => {
    const seen = serveSite(site);
    const res = await createHttpRequestTool().execute({ url: "https://docs.example/api/items/9", method: "DELETE" });
    expect(res.content).not.toContain("closest match");
    expect(seen).toEqual(["https://docs.example/api/items/9"]);
  });
});

describe("browser navigate hands back leads for a missing page", () => {
  it("turns a 404 navigation failure into leads on the same site", async () => {
    const { handleNavigate } = await import("./browser-tools/navigation.js");
    serveSite({
      "https://docs.example/docs": `<a href="/docs/v3/rate-limits">Rate limits</a>`,
    });
    const manager = {
      navigate: async () => { throw new Error("Navigation failed: HTTP 404 (docs.example/docs/v2/limits)"); },
    } as unknown as Parameters<typeof handleNavigate>[0];
    const res = await handleNavigate(manager, { url: "https://docs.example/docs/v2/limits" }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("https://docs.example/docs/v3/rate-limits");
  });

  it("rethrows other navigation failures unchanged", async () => {
    const { handleNavigate } = await import("./browser-tools/navigation.js");
    const manager = {
      navigate: async () => { throw new Error("Navigation failed: HTTP 500 (docs.example/x)"); },
    } as unknown as Parameters<typeof handleNavigate>[0];
    await expect(handleNavigate(manager, { url: "https://docs.example/x" }, undefined)).rejects.toThrow("HTTP 500");
  });
});
