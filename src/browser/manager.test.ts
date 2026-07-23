import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "playwright";
import { BrowserManager } from "./manager.js";
import { installRequestGuard } from "./guards.js";
import { installDownloadHandler } from "./downloads.js";
import { handleNewTab } from "../tools/browser-tools/navigation.js";

// Post-fill readback policy contract (per Chunk C / fill-mask refactor):
//   1. value matches    → returns "Filled ... with value (N chars)"
//   2. value mismatches  → THROWS  "Fill did not land: expected 'X' got 'Y'"
//   3. empty + type=password → ok with "verification skipped: masked input"
//   4. empty + non-password  → throws (treated as a real mismatch)
//   5. readback machinery throws → ok with "verification skipped: readback failed"
//
// We don't spin up Playwright — we stub getPage() with a hand-rolled page.

interface FakeLocator {
  inputValue: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
}

interface FakePage {
  waitForSelector: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  locator: (selector: string) => FakeLocator;
}

function buildPage(opts: {
  readback: string | (() => Promise<string>);
  attrType?: string | null;
}): FakePage {
  return {
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    locator: () => ({
      inputValue: async () =>
        typeof opts.readback === "function" ? opts.readback() : opts.readback,
      getAttribute: async () => opts.attrType ?? null,
    }),
  };
}

function makeManager(page: FakePage): BrowserManager {
  const mgr = new BrowserManager("test-session");
  // Replace getPage so no real browser is touched.
  (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
    .fn()
    .mockResolvedValue(page);
  return mgr;
}

describe("BrowserManager.fill — readback policy", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns ok when the readback matches the filled value", async () => {
    const page = buildPage({ readback: "hello" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#user", "hello");

    expect(result).toBe(`Filled "#user" with value (5 chars)`);
    expect(page.waitForSelector).toHaveBeenCalledWith("#user", { state: "visible", timeout: 5000 });
    expect(page.fill).toHaveBeenCalledWith("#user", "hello", expect.any(Object));
  });

  it("throws when the readback value does NOT match the filled value", async () => {
    const page = buildPage({ readback: "WRONG" });
    const mgr = makeManager(page);

    await expect(mgr.fill("#user", "hello")).rejects.toThrow(
      /Fill did not land: expected 'hello' got 'WRONG'/,
    );
  });

  it("returns ok with masked-input note when readback is empty and type=password", async () => {
    const page = buildPage({ readback: "", attrType: "password" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#pw", "hunter2");

    expect(result).toBe(`Filled "#pw" (verification skipped: masked input)`);
  });

  it("returns ok normally when a password input echoes back its real value", async () => {
    // Some password fields aren't really masked at the DOM level (e.g. show-password toggles).
    // If inputValue() returns the same string, normal verification path wins — no skip note.
    const page = buildPage({ readback: "hunter2", attrType: "password" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#pw", "hunter2");

    expect(result).toBe(`Filled "#pw" with value (7 chars)`);
    expect(result).not.toContain("verification skipped");
  });

  it("returns ok with readback-failed note when the locator itself throws", async () => {
    // Simulate post-fill detachment / navigation. The successful fill must not
    // be retroactively reported as failed just because readback machinery broke.
    const page = buildPage({
      readback: () => Promise.reject(new Error("Target closed")),
    });
    const mgr = makeManager(page);

    const result = await mgr.fill("#user", "hello");

    expect(result).toBe(`Filled "#user" (verification skipped: readback failed)`);
  });

  it("throws when readback returns empty and the input is NOT a password", async () => {
    // An empty readback on a plain text input is a real mismatch — not a mask.
    const page = buildPage({ readback: "", attrType: "text" });
    const mgr = makeManager(page);

    await expect(mgr.fill("#user", "hello")).rejects.toThrow(/Fill did not land/);
  });
});

// ── Download handler idempotence (BR-6) ──
// adoptPage runs installDownloadHandler on EVERY switch_tab. Without a
// per-page guard (like the dialog handler's WeakMap), flipping between two
// tabs stacks N listeners that each save the same download — collisions,
// duplicate files, MaxListeners warnings.

describe("installDownloadHandler — idempotence per page", () => {
  it("registers at most one download listener no matter how often a page is re-adopted", () => {
    const page = { on: vi.fn() } as unknown as Page;
    installDownloadHandler(page);
    installDownloadHandler(page);
    installDownloadHandler(page);
    expect((page.on as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => event === "download")).toHaveLength(1);
    expect((page.on as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => event === "response")).toHaveLength(1);
  });

  it("still installs a listener on each distinct page", () => {
    const a = { on: vi.fn() } as unknown as Page;
    const b = { on: vi.fn() } as unknown as Page;
    installDownloadHandler(a);
    installDownloadHandler(b);
    expect((a.on as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => event === "download")).toHaveLength(1);
    expect((b.on as ReturnType<typeof vi.fn>).mock.calls.filter(([event]) => event === "download")).toHaveLength(1);
  });
});

// ── navigate / newTab contracts (BR-7 / BR-10) ──
// Fake pages good enough to drive goto flows without Playwright.

interface NavFakePage {
  setDefaultTimeout: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  bringToFront: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  url: () => string;
  close: ReturnType<typeof vi.fn>;
  isClosed: () => boolean;
}

function navFakePage(status: number, url: string): NavFakePage {
  let closed = false;
  return {
    setDefaultTimeout: vi.fn(),
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue({ status: () => status }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Fake Title"),
    url: () => url,
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    isClosed: () => closed,
  };
}

describe("BrowserManager.newTab — HTTP ≥400 guard (parity with navigate)", () => {
  function makeTabManager(page: NavFakePage): BrowserManager {
    const mgr = new BrowserManager("test-session");
    (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
      .fn()
      .mockResolvedValue(page);
    (mgr as unknown as { context: unknown }).context = {
      newPage: vi.fn().mockResolvedValue(page),
    };
    return mgr;
  }

  it("throws on an HTTP 404 instead of reporting 'Status: 404' as success", async () => {
    const page = navFakePage(404, "http://example.com/missing");
    const mgr = makeTabManager(page);

    await expect(mgr.newTab("http://example.com/missing")).rejects.toThrow(
      /Navigation failed: HTTP 404/,
    );
  });

  it("closes the failed tab so it does not linger in the owned tab list", async () => {
    const page = navFakePage(500, "http://example.com/boom");
    const mgr = makeTabManager(page);

    await expect(mgr.newTab("http://example.com/boom")).rejects.toThrow(/HTTP 500/);
    expect(page.close).toHaveBeenCalled();
    expect(mgr.listOwnedPages()).toHaveLength(0);
  });

  it("removes AND closes a tab whose goto THROWS so it never leaks into owned", async () => {
    // A goto that rejects (DNS, NAV_TIMEOUT, egress-abort) — not just an HTTP
    // ≥400 response — must also unwind the just-pushed page, else a dead/blank
    // tab lingers in every future listTabs and shifts switch_tab indexes.
    const page = navFakePage(200, "http://does-not-resolve.example/");
    page.goto = vi.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    const mgr = makeTabManager(page);

    await expect(mgr.newTab("http://does-not-resolve.example/")).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/,
    );
    expect(page.close).toHaveBeenCalled();
    expect(mgr.listOwnedPages()).toHaveLength(0);
  });

  it("unwinds the tab when a POST-goto op throws (OAuth/redirect bounce) — no strand, no dead active page", async () => {
    // goto succeeds but the page self-closes before bringToFront (common on an
    // OAuth/redirect bounce). The whole newTab must unwind — not just a throwing
    // goto — and this.page must not be left pointing at the dead tab.
    const page = navFakePage(200, "http://example.com/bounce");
    page.bringToFront = vi.fn().mockRejectedValue(new Error("Target page closed"));
    const mgr = makeTabManager(page);

    await expect(mgr.newTab("http://example.com/bounce")).rejects.toThrow(/Target page closed/);
    expect(page.close).toHaveBeenCalled();
    expect(mgr.listOwnedPages()).toHaveLength(0);
    expect(mgr.getCurrentUrl()).not.toContain("bounce");
  });

  it("still reports success for a 200 response", async () => {
    const page = navFakePage(200, "http://example.com/");
    const mgr = makeTabManager(page);

    const result = await mgr.newTab("http://example.com/");
    expect(result).toContain("Status: 200");
    expect(page.close).not.toHaveBeenCalled();
  });

  it("classifies a recovery destination before reading its title", async () => {
    const page = navFakePage(200, "https://example.com/account-recovery/private-token");
    const mgr = makeTabManager(page);
    const result = await mgr.newTab("https://example.com/account-recovery/private-token");
    expect(result).toContain("SENSITIVE PAGE CONTENT WITHHELD");
    expect(page.title).not.toHaveBeenCalled();
  });
});

// ── handleNewTab multi-URL fan-out (C4) ──
// One tool call opens N tabs so multi-site opens are deterministic regardless
// of model looping behavior; a failing URL never aborts the others.

describe("handleNewTab — multi-URL fan-out (C4)", () => {
  function makeMultiTabManager(pages: NavFakePage[]) {
    const mgr = new BrowserManager("test-session");
    (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
      .fn()
      .mockResolvedValue(pages[0]);
    const newPage = vi.fn();
    for (const page of pages) newPage.mockResolvedValueOnce(page);
    (mgr as unknown as { context: unknown }).context = { newPage };
    const snapshotSpy = vi.fn().mockResolvedValue("SNAPSHOT");
    (mgr as unknown as { snapshot: () => Promise<string> }).snapshot = snapshotSpy;
    return { mgr, snapshotSpy, newPage };
  }

  it("one call with three urls opens three tabs, rows in input order, ONE trailing snapshot", async () => {
    const pages = [
      navFakePage(200, "https://one.example/"),
      navFakePage(200, "https://two.example/"),
      navFakePage(200, "https://three.example/"),
    ];
    const { mgr, snapshotSpy } = makeMultiTabManager(pages);

    const result = await handleNewTab(mgr, {
      urls: ["https://one.example/", "https://two.example/", "https://three.example/"],
    });

    expect(result.isError).toBeFalsy();
    expect(mgr.listOwnedPages()).toHaveLength(3);
    expect(result.content).toContain("Opened 3 of 3 tabs.");
    // Per-URL sections appear in INPUT order.
    const i1 = result.content.indexOf("[1/3] https://one.example/");
    const i2 = result.content.indexOf("[2/3] https://two.example/");
    const i3 = result.content.indexOf("[3/3] https://three.example/");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // Only the ACTIVE (last-opened) tab gets the deep snapshot — exactly one.
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("--- Page snapshot ---");
  });

  it("one bad URL does not prevent the other tabs (per-URL isolation)", async () => {
    const pages = [
      navFakePage(200, "https://one.example/"),
      navFakePage(404, "https://broken.example/missing"),
      navFakePage(200, "https://three.example/"),
    ];
    const { mgr } = makeMultiTabManager(pages);

    const result = await handleNewTab(mgr, {
      urls: ["https://one.example/", "https://broken.example/missing", "https://three.example/"],
    });

    // Partial success is SUCCESS — the error is reported per-row, not globally.
    expect(result.isError).toBeFalsy();
    expect(mgr.listOwnedPages()).toHaveLength(2); // the 404 tab was closed by newTab
    expect(result.content).toContain("Opened 2 of 3 tabs.");
    expect(result.content).toMatch(/\[2\/3\] https:\/\/broken\.example\/missing\nError: Navigation failed: HTTP 404/);
    expect(result.content).toContain("[1/3] https://one.example/");
    expect(result.content).toContain("[3/3] https://three.example/");
  });

  it("all urls failing returns an error result with every per-URL row", async () => {
    const pages = [
      navFakePage(500, "https://a.example/boom"),
      navFakePage(404, "https://b.example/missing"),
    ];
    const { mgr, snapshotSpy } = makeMultiTabManager(pages);

    const result = await handleNewTab(mgr, {
      urls: ["https://a.example/boom", "https://b.example/missing"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Opened 0 of 2 tabs.");
    expect(result.content).toContain("HTTP 500");
    expect(result.content).toContain("HTTP 404");
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("'urls' takes precedence over 'url' when both are set", async () => {
    const pages = [navFakePage(200, "https://one.example/"), navFakePage(200, "https://two.example/")];
    const { mgr } = makeMultiTabManager(pages);

    const result = await handleNewTab(mgr, {
      url: "https://ignored.example/",
      urls: ["https://one.example/", "https://two.example/"],
    });

    expect(result.content).toContain("Opened 2 of 2 tabs.");
    expect(pages[0].goto).toHaveBeenCalledWith("https://one.example/", expect.any(Object));
    expect(pages[1].goto).toHaveBeenCalledWith("https://two.example/", expect.any(Object));
    for (const page of pages) {
      expect(page.goto).not.toHaveBeenCalledWith("https://ignored.example/", expect.any(Object));
    }
  });

  it("single-url path is unchanged: bare tab report + one appended snapshot, no fan-out framing", async () => {
    const page = navFakePage(200, "https://one.example/");
    const { mgr, snapshotSpy } = makeMultiTabManager([page]);

    const result = await handleNewTab(mgr, { url: "https://one.example/" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Opened new tab (1 tabs total)");
    expect(result.content).toContain("--- Page snapshot ---");
    expect(result.content).not.toContain("[1/1]");
    expect(result.content).not.toContain("Opened 1 of 1");
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("neither 'url' nor 'urls' is an error, and an all-blank urls array falls back to 'url'", async () => {
    const { mgr } = makeMultiTabManager([navFakePage(200, "https://one.example/")]);

    const missing = await handleNewTab(mgr, {});
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("'url' (or 'urls')");

    const fallback = await handleNewTab(mgr, { urls: ["", "  "], url: "https://one.example/" });
    expect(fallback.isError).toBeFalsy();
    expect(fallback.content).toContain("Opened new tab (1 tabs total)");
  });

  it("rejects an oversized batch before opening any tab", async () => {
    const { mgr, newPage } = makeMultiTabManager([navFakePage(200, "https://one.example/")]);
    const result = await handleNewTab(mgr, {
      urls: Array.from({ length: 11 }, (_, i) => `https://site-${i}.example/`),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("at most 10 URLs");
    expect(newPage).not.toHaveBeenCalled();
  });
});

describe("BrowserManager.navigate — single observation per navigation", () => {
  it("does not snapshot at the manager level (handleNavigate appends the canonical one)", async () => {
    const page = navFakePage(200, "http://example.com/");
    const mgr = new BrowserManager("test-session");
    (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
      .fn()
      .mockResolvedValue(page);
    const snapshotSpy = vi.fn().mockResolvedValue("SNAPSHOT");
    (mgr as unknown as { snapshot: () => Promise<string> }).snapshot = snapshotSpy;

    const result = await mgr.navigate("http://example.com/");

    // Double full-DOM extraction per navigate (BR-10): navigate() must NOT
    // observe — the one post-action snapshot is appended by handleNavigate.
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(result).toBe("Navigated to: http://example.com/\nStatus: 200\nTitle: Fake Title");
  });

  it("still throws on HTTP ≥400", async () => {
    const page = navFakePage(404, "http://example.com/missing");
    const mgr = new BrowserManager("test-session");
    (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
      .fn()
      .mockResolvedValue(page);

    await expect(mgr.navigate("http://example.com/missing")).rejects.toThrow(
      /Navigation failed: HTTP 404/,
    );
  });

  it("classifies a private-key destination before reading its title", async () => {
    const page = navFakePage(200, "https://example.com/private-keys/private-token");
    const mgr = new BrowserManager("test-session");
    (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi.fn().mockResolvedValue(page);
    const result = await mgr.navigate("https://example.com/private-keys/private-token");
    expect(result).toContain("SENSITIVE PAGE CONTENT WITHHELD");
    expect(page.title).not.toHaveBeenCalled();
  });
});

// ── Context-level request guard (R4-01 / R4-02) ──
// The guard must abort any navigation a driven page makes — click/act/fill/
// redirect — that targets a private/loopback/metadata host or a blocked
// scheme, while letting public hosts through. We don't launch Playwright:
// installRequestGuard registers a handler via context.route(), so we capture
// that handler and drive it with fake route/request objects.

interface FakeRoute {
  abort: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fulfill: ReturnType<typeof vi.fn>;
}

function fakeRoute(): FakeRoute {
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue({ headers: () => ({}) }),
    fulfill: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeRequest(url: string, opts: { resourceType?: string; navigation?: boolean; parentFrame?: unknown } = {}) {
  // Model Playwright's Request.frame(): a main-frame request has no parent frame
  // (parentFrame() === null); an iframe request has one. The top-level-document
  // predicate now reads this to avoid stamping frame-ancestors on embedded frames.
  const parentFrame = opts.parentFrame ?? null;
  return {
    url: () => url,
    resourceType: () => opts.resourceType ?? "document",
    isNavigationRequest: () => opts.navigation ?? true,
    frame: () => ({ parentFrame: () => parentFrame }),
  };
}

type RouteHandler = (route: FakeRoute, request: ReturnType<typeof fakeRequest>) => Promise<void>;

async function captureGuard(): Promise<RouteHandler> {
  let handler: RouteHandler | undefined;
  const fakeContext = {
    route: vi.fn(async (_pattern: string, h: RouteHandler) => { handler = h; }),
  };
  // Each call passes a brand-new fakeContext object, so the install-once
  // WeakSet never short-circuits between tests.
  await installRequestGuard(fakeContext as unknown as Parameters<typeof installRequestGuard>[0]);
  if (!handler) throw new Error("guard did not register a route handler");
  return handler;
}

describe("installRequestGuard — context-level SSRF/scheme guard", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("retries installation after context.route rejects", async () => {
    let handler: RouteHandler | undefined;
    const context = {
      route: vi.fn()
        .mockRejectedValueOnce(new Error("route registration failed"))
        .mockImplementationOnce(async (_pattern: string, candidate: RouteHandler) => {
          handler = candidate;
        }),
    };
    const typedContext = context as unknown as Parameters<typeof installRequestGuard>[0];

    await expect(installRequestGuard(typedContext)).rejects.toThrow("route registration failed");
    await expect(installRequestGuard(typedContext)).resolves.toBeUndefined();
    await installRequestGuard(typedContext);

    expect(handler).toBeTypeOf("function");
    expect(context.route).toHaveBeenCalledTimes(2);
  });

  it("aborts a navigation to loopback (127.0.0.1) on a non-self port", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("http://127.0.0.1:8088/admin"));
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("aborts a navigation to the cloud metadata endpoint", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("http://169.254.169.254/latest/meta-data/"));
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("aborts a top-level document navigation to file:", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("file:///etc/passwd"));
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("lets a non-document data: sub-resource through (only top-level docs are killed)", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("data:image/png;base64,AAAA", { resourceType: "image", navigation: false }));
    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("allows a navigation to a public host — fulfilled with CSP, never aborted (literal public IP, no DNS)", async () => {
    // Literal public IP is validated synchronously by the canonical gate, so
    // this stays deterministic offline (no live DNS for a hostname). A public
    // top-level document takes the fetch+fulfill CSP-injection path rather than
    // continue(); the point of this case is that it is ALLOWED (not aborted).
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("http://93.184.216.34/"));
    expect(route.fulfill).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });
});

// ── Context "page" event → popup / target=_blank adoption ──
// The CDP backend must subscribe to context "page" so a page the SITE opens
// (window.open / target=_blank) lands in `owned` — otherwise it never reaches
// listTabs/switch_tab and the agent stays pinned to the useless opener tab.
// advanced-shared mode shares ONE context across sessions, so adoption is gated
// on opener() ownership: a manager never adopts a popup a PEER's tab opened
// (the cross-session-leak guard). We don't launch Playwright — wirePopupAdoption
// registers via context.on("page", h), so we capture h and drive it with fakes.

describe("BrowserManager — context 'page' event adopts site-opened tabs", () => {
  type PageHandler = (p: Page) => void;

  /** Drive wirePopupAdoption with a fake context that captures the "page"
   *  handler, then let the test emit pages through it (mirrors captureGuard). */
  function wire(mgr: BrowserManager): { emit: (p: NavFakePage) => void; on: ReturnType<typeof vi.fn> } {
    let handler: PageHandler | undefined;
    const on = vi.fn((event: string, h: PageHandler) => { if (event === "page") handler = h; });
    (mgr as unknown as { wirePopupAdoption: (c: unknown) => void }).wirePopupAdoption({ on });
    return {
      emit: (p) => { if (!handler) throw new Error("no 'page' handler was wired"); handler(p as unknown as Page); },
      on,
    };
  }

  function withOpener(page: NavFakePage, opener: NavFakePage | null): NavFakePage {
    (page as unknown as { opener: () => Promise<unknown> }).opener = vi.fn().mockResolvedValue(opener);
    return page;
  }

  function seedOwned(mgr: BrowserManager, pages: NavFakePage[]): void {
    (mgr as unknown as { owned: Page[] }).owned = pages as unknown as Page[];
    (mgr as unknown as { page: Page | null }).page = (pages[0] as unknown as Page) ?? null;
  }

  // Let the handler's single `await p.opener()` settle: a macrotask fires only
  // after the microtask queue (the opener() continuation) has fully drained.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("adopts a popup opened by one of our tabs → listTabs shows it and switchTab reaches it", async () => {
    const mgr = new BrowserManager("test-session");
    const opener = navFakePage(200, "https://opener.example/");
    seedOwned(mgr, [opener]);
    const popup = withOpener(navFakePage(200, "https://popup.example/"), opener);

    const { emit } = wire(mgr);
    emit(popup);
    await flush();

    expect(mgr.listOwnedPages()).toHaveLength(2);
    expect(mgr.listOwnedPages()).toContain(popup as unknown as Page);
    expect(await mgr.listTabs()).toContain("https://popup.example/");
    // switch_tab can now reach the adopted popup (index 1 = the second owned tab).
    expect(await mgr.switchTab(1)).toContain("https://popup.example/");
  });

  it("adopts a popup but does NOT steal focus — this.page stays on the current tab", async () => {
    // A context "page" event is SITE-initiated (ad / analytics / background
    // window.open / OAuth). Adopting it must not hijack the agent off the tab
    // it is driving; the agent moves to the popup deliberately via switch_tab.
    const mgr = new BrowserManager("test-session");
    const opener = navFakePage(200, "https://opener.example/");
    seedOwned(mgr, [opener]); // this.page = opener
    const popup = withOpener(navFakePage(200, "https://popup.example/"), opener);

    const { emit } = wire(mgr);
    emit(popup);
    await flush();

    expect(mgr.listOwnedPages()).toContain(popup as unknown as Page); // listable
    expect(mgr.getCurrentUrl()).toBe("https://opener.example/"); // but NOT stolen
  });

  it("adopts a popup our tab opened even in advanced-shared mode (opener is ours)", async () => {
    // Positive control for the peer test below: proves the opener gate ALLOWS
    // our own popups in shared mode — it isn't just blanket-refusing everything.
    const mgr = new BrowserManager("test-session", "advanced-shared");
    const mine = navFakePage(200, "https://mine.example/");
    seedOwned(mgr, [mine]);
    mgr.setPeerPages(() => []);
    const popup = withOpener(navFakePage(200, "https://mine-popup.example/"), mine);

    const { emit } = wire(mgr);
    emit(popup);
    await flush();

    expect(mgr.listOwnedPages()).toContain(popup as unknown as Page);
  });

  it("in advanced-shared mode does NOT adopt a popup a PEER session's tab opened", async () => {
    const mgr = new BrowserManager("test-session", "advanced-shared");
    const mine = navFakePage(200, "https://mine.example/");
    const peerTab = navFakePage(200, "https://peer.example/");
    seedOwned(mgr, [mine]);
    mgr.setPeerPages(() => [peerTab as unknown as Page]);
    // The popup's opener is the PEER's tab — not one of ours — so adopting it
    // would be a cross-session leak.
    const peerPopup = withOpener(navFakePage(200, "https://peer-popup.example/"), peerTab);

    const { emit } = wire(mgr);
    emit(peerPopup);
    await flush();

    expect(mgr.listOwnedPages()).toHaveLength(1);
    expect(mgr.listOwnedPages()).not.toContain(peerPopup as unknown as Page);
  });

  it("does not adopt a page with a null opener (our own newPage / rel=noopener) — conservative", async () => {
    const mgr = new BrowserManager("test-session");
    const mine = navFakePage(200, "https://mine.example/");
    seedOwned(mgr, [mine]);
    const orphan = withOpener(navFakePage(200, "https://orphan.example/"), null);

    const { emit } = wire(mgr);
    emit(orphan);
    await flush();

    expect(mgr.listOwnedPages()).toHaveLength(1);
    expect(mgr.listOwnedPages()).not.toContain(orphan as unknown as Page);
  });

  it("wires the 'page' handler at most once per context (no stacked handlers on re-acquire)", () => {
    const mgr = new BrowserManager("test-session");
    const on = vi.fn();
    const ctx = { on };
    const wireOnce = () => (mgr as unknown as { wirePopupAdoption: (c: unknown) => void }).wirePopupAdoption(ctx);
    wireOnce(); wireOnce(); wireOnce();
    expect(on.mock.calls.filter(([event]) => event === "page")).toHaveLength(1);
  });
});
