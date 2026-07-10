import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser } from "playwright";
import type { ChildProcess } from "node:child_process";

// Cross-session browser identity isolation. The browserPerSessionContext
// default flip relies on one semantic: isolated=true mints a FRESH
// BrowserContext per session (own cookie jar), isolated=false reuses the one
// shared context. No test file pinned that before — instance.test.ts only
// proves manager-level identity, never context/cookie identity.
//
// No browser-test layer in this repo launches a real chromium (manager.test.ts
// and friends all fake Playwright objects), so we follow suit: launchViaCDP is
// mocked to hand runtime.ts a fake Browser whose newContext() mints fake
// contexts with FAITHFUL per-context cookie jars. That models Playwright's
// documented contract — each BrowserContext owns an independent cookie store —
// so proving "distinct context instances" + "jar writes don't cross instances"
// pins the cookie-separation behavior at the interface level.

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

function makeFakeContext(options: Record<string, unknown>) {
  const jar: FakeCookie[] = [];
  const openPages: unknown[] = [];
  return {
    options,
    addCookies: async (cookies: FakeCookie[]) => { jar.push(...cookies); },
    cookies: async () => [...jar],
    pages: () => openPages as never[],
    newPage: async () => {
      const page = makeFakePage();
      openPages.push(page);
      return page;
    },
    route: async () => {},
    close: async () => {},
  };
}

function makeFakePage() {
  let closed = false;
  return {
    setDefaultTimeout: () => {},
    on: () => {},
    isClosed: () => closed,
    url: () => "about:blank",
    title: async () => "",
    close: async () => { closed = true; },
  };
}

function makeFakeBrowser() {
  const minted: ReturnType<typeof makeFakeContext>[] = [];
  return {
    minted,
    isConnected: () => true,
    contexts: () => minted,
    newContext: async (options: Record<string, unknown>) => {
      const ctx = makeFakeContext(options);
      minted.push(ctx);
      return ctx;
    },
    close: async () => {},
  };
}

// Holder must be hoisted so the vi.mock factory (which vitest lifts above
// imports) can reach the per-test fake browser.
const holder = vi.hoisted(() => ({
  browser: null as ReturnType<typeof makeFakeBrowser> | null,
}));

vi.mock("../src/browser/launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser/launcher.js")>();
  return {
    ...actual,
    launchViaCDP: async () => ({
      browser: holder.browser as unknown as Browser,
      chromeProcess: { kill: () => {} } as unknown as ChildProcess,
    }),
  };
});

import { acquireSessionContext, closeSharedBrowser } from "../src/browser/runtime.js";
import { USER_AGENTS } from "../src/browser/launcher.js";
import { BrowserManager } from "../src/browser/manager.js";

let fake: ReturnType<typeof makeFakeBrowser>;

beforeEach(() => {
  fake = makeFakeBrowser();
  holder.browser = fake;
});

afterEach(async () => {
  // runtime.ts caches the Browser at module level — reset it so each test
  // launches (and gets) its own fresh fake.
  await closeSharedBrowser();
});

describe("acquireSessionContext — per-session context identity", () => {
  it("isolated=true mints a distinct context per call (separate identities)", async () => {
    const a = await acquireSessionContext("chromium", true);
    const b = await acquireSessionContext("chromium", true);
    expect(a).not.toBe(b);
    expect(fake.minted).toHaveLength(2);
  });

  it("isolated=false reuses one shared context across calls", async () => {
    const a = await acquireSessionContext("chromium", false);
    const b = await acquireSessionContext("chromium", false);
    expect(a).toBe(b);
    expect(fake.minted).toHaveLength(1);
  });

  it("applies CONTEXT_OPTS (UA/viewport/locale/timezone) to every minted context", async () => {
    await acquireSessionContext("chromium", true);
    await acquireSessionContext("chromium", true);
    for (const ctx of fake.minted) {
      expect(ctx.options.userAgent).toBe(USER_AGENTS.chromium);
      expect(ctx.options.viewport).toEqual({ width: 1280, height: 800 });
      expect(ctx.options.locale).toBe("en-US");
      expect(ctx.options.timezoneId).toBe("America/Chicago");
    }
  });
});

describe("cross-session cookie separation (isolated contexts)", () => {
  it("a cookie set in session A's context is not visible in session B's", async () => {
    const ctxA = await acquireSessionContext("chromium", true);
    const ctxB = await acquireSessionContext("chromium", true);

    await ctxA.addCookies([
      { name: "sid", value: "session-a-secret", domain: "example.com", path: "/" },
    ]);

    const aCookies = await ctxA.cookies();
    const bCookies = await ctxB.cookies();
    expect(aCookies.map((c) => c.name)).toContain("sid");
    expect(bCookies).toHaveLength(0);
  });

  it("shared mode keeps one jar: a cookie set by one caller is visible to the next", async () => {
    // The continuity default the flag replaced — pinned so a regression in
    // shared mode (accidentally minting fresh contexts) also fails loudly.
    const ctxA = await acquireSessionContext("chromium", false);
    await ctxA.addCookies([
      { name: "login", value: "shared", domain: "example.com", path: "/" },
    ]);
    const ctxB = await acquireSessionContext("chromium", false);
    expect((await ctxB.cookies()).map((c) => c.name)).toContain("login");
  });
});

describe("BrowserManager — session managers land in distinct contexts when isolated", () => {
  const managers: BrowserManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) {
      try { await m.close(); } catch { /* fake teardown */ }
    }
  });

  function mgr(sessionId: string, isolated: boolean): BrowserManager {
    const m = new BrowserManager(sessionId, isolated);
    managers.push(m);
    return m;
  }

  it("two isolated session managers acquire different context objects", async () => {
    await mgr("chat-1", true).getPage();
    await mgr("cron-nightly", true).getPage();
    expect(fake.minted).toHaveLength(2);
    expect(fake.minted[0]).not.toBe(fake.minted[1]);
  });

  it("two shared-mode session managers acquire the same context object", async () => {
    await mgr("chat-1", false).getPage();
    await mgr("cron-nightly", false).getPage();
    expect(fake.minted).toHaveLength(1);
  });

  it("cookies written via one isolated session's context never reach the other's", async () => {
    const a = mgr("chat-1", true);
    const b = mgr("cron-nightly", true);
    await a.getPage();
    await b.getPage();

    const [ctxA, ctxB] = fake.minted;
    await ctxA.addCookies([
      { name: "auth", value: "a-only", domain: "example.com", path: "/" },
    ]);
    expect(await ctxB.cookies()).toHaveLength(0);
    expect((await ctxA.cookies()).map((c) => c.name)).toContain("auth");
  });
});
