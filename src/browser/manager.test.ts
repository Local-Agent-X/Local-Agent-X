import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page, BrowserContext } from "playwright";
import { BrowserManager } from "./manager.js";
import { installRequestGuard } from "./guards.js";
import { installDownloadHandler } from "./downloads.js";
import { acquireSessionContext } from "./runtime.js";

vi.mock("./runtime.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./runtime.js")>();
  return { ...orig, acquireSessionContext: vi.fn() };
});
vi.mock("../config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../config.js")>();
  return { ...orig, getRuntimeConfig: () => ({ browserIdleTimeoutMs: 60_000 }) };
});

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
    installDownloadHandler(page, "sess");
    installDownloadHandler(page, "sess");
    installDownloadHandler(page, "sess");
    expect((page.on as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("still installs a listener on each distinct page", () => {
    const a = { on: vi.fn() } as unknown as Page;
    const b = { on: vi.fn() } as unknown as Page;
    installDownloadHandler(a, "sess-a");
    installDownloadHandler(b, "sess-b");
    expect((a.on as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((b.on as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
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

  it("still reports success for a 200 response", async () => {
    const page = navFakePage(200, "http://example.com/");
    const mgr = makeTabManager(page);

    const result = await mgr.newTab("http://example.com/");
    expect(result).toContain("Status: 200");
    expect(page.close).not.toHaveBeenCalled();
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
}

function fakeRoute(): FakeRoute {
  return { abort: vi.fn().mockResolvedValue(undefined), continue: vi.fn().mockResolvedValue(undefined) };
}

function fakeRequest(url: string, opts: { resourceType?: string; navigation?: boolean } = {}) {
  return {
    url: () => url,
    resourceType: () => opts.resourceType ?? "document",
    isNavigationRequest: () => opts.navigation ?? true,
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

  it("continues a navigation to a public host (literal public IP, no DNS)", async () => {
    // Literal public IP is validated synchronously by the canonical gate, so
    // this stays deterministic offline (no live DNS for a hostname).
    const handler = await captureGuard();
    const route = fakeRoute();
    await handler(route, fakeRequest("http://93.184.216.34/"));
    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });
});

// ── getPage re-acquire: stale context disposal (C16) ──
// When the cached page is dead (user closed it, or title() throws), getPage
// mints a new context. The OLD isolated context must be closed first — it
// otherwise leaks inside the shared Chrome until Chrome exits. The shared
// context must NEVER be closed: other sessions' pages live in it.

function staleCachedPage(kind: "throws" | "closed") {
  return {
    isClosed: () => kind === "closed",
    title: () => Promise.reject(new Error("Target closed")),
  };
}

function freshContextAndPage() {
  const page = {
    setDefaultTimeout: vi.fn(),
    on: vi.fn(),
    isClosed: () => false,
    url: () => "about:blank",
  };
  const context = {
    route: vi.fn().mockResolvedValue(undefined),
    pages: () => [],
    newPage: vi.fn().mockResolvedValue(page),
  };
  return { context, page };
}

function setupReacquire(isolated: boolean, kind: "throws" | "closed") {
  const mgr = new BrowserManager("test-session", isolated);
  const staleClose = vi.fn().mockResolvedValue(undefined);
  const internal = mgr as unknown as { page: unknown; context: unknown };
  internal.page = staleCachedPage(kind);
  internal.context = { close: staleClose };
  const fresh = freshContextAndPage();
  vi.mocked(acquireSessionContext).mockResolvedValue(fresh.context as unknown as BrowserContext);
  return { mgr, staleClose, fresh };
}

describe("BrowserManager.getPage — stale context disposal on re-acquire", () => {
  beforeEach(() => { vi.mocked(acquireSessionContext).mockReset(); });

  it("isolated: closes the old context when the cached page's title() throws", async () => {
    const { mgr, staleClose, fresh } = setupReacquire(true, "throws");
    const page = await mgr.getPage();
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(acquireSessionContext)).toHaveBeenCalledWith("chromium", true);
    expect(page).toBe(fresh.page);
  });

  it("isolated: closes the old context when the cached page was closed by the user", async () => {
    const { mgr, staleClose, fresh } = setupReacquire(true, "closed");
    const page = await mgr.getPage();
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(page).toBe(fresh.page);
  });

  it("shared: does NOT close the old context (other sessions live in it)", async () => {
    const { mgr, staleClose, fresh } = setupReacquire(false, "throws");
    const page = await mgr.getPage();
    expect(staleClose).not.toHaveBeenCalled();
    expect(page).toBe(fresh.page);
  });

  it("isolated: a failing close() is swallowed and re-acquire still succeeds", async () => {
    const { mgr, staleClose, fresh } = setupReacquire(true, "throws");
    staleClose.mockRejectedValue(new Error("context already closed"));
    const page = await mgr.getPage();
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(page).toBe(fresh.page);
  });

  it("does not touch the context while the cached page is still alive", async () => {
    const mgr = new BrowserManager("test-session", true);
    const staleClose = vi.fn();
    const alive = { isClosed: () => false, title: vi.fn().mockResolvedValue("ok") };
    const internal = mgr as unknown as { page: unknown; context: unknown };
    internal.page = alive;
    internal.context = { close: staleClose };
    const page = await mgr.getPage();
    expect(page).toBe(alive);
    expect(staleClose).not.toHaveBeenCalled();
    expect(vi.mocked(acquireSessionContext)).not.toHaveBeenCalled();
  });
});
