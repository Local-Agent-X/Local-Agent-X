import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserManager } from "./manager.js";
import { installRequestGuard } from "./guards.js";

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
