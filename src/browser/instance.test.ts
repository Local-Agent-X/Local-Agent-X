import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright";

const mocks = vi.hoisted(() => {
  const contexts: BrowserContext[] = [];
  const browser = {
    isConnected: () => true,
    contexts: () => contexts,
    newContext: vi.fn(async () => {
      const context = { id: Symbol("context") } as unknown as BrowserContext;
      contexts.push(context);
      return context;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  const startProxy = vi.fn();
  const closeProxy = vi.fn(async () => undefined);
  return { browser, contexts, startProxy, closeProxy };
});

vi.mock("./egress-proxy.js", () => ({
  ensureBrowserEgressProxy: mocks.startProxy,
  closeBrowserEgressProxy: mocks.closeProxy,
}));

vi.mock("./launcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./launcher.js")>();
  return {
    ...original,
    launchViaCDP: vi.fn(async () => ({ browser: mocks.browser, chromeProcess: null })),
  };
});

import { getBrowserManager, closeBrowser, closeAllBrowsers } from "./instance.js";
import { acquireSessionContext, closeSharedBrowser } from "./runtime.js";
import { configSchema } from "../config-schema.js";

// These exercise the per-session isolation contract at the registry level —
// no Chrome is launched (a manager stays inert until getPage()), so they run
// fast and deterministically. The guarantee under test: each session gets its
// own manager (own tabs + ref registry), and tearing one down never touches
// another.
describe("per-session browser isolation", () => {
  afterEach(async () => { await closeAllBrowsers(); });

  it("returns the same manager for the same session id", () => {
    expect(getBrowserManager("chat-1")).toBe(getBrowserManager("chat-1"));
  });

  it("returns distinct managers for distinct sessions", () => {
    const chat = getBrowserManager("chat-1");
    const mission = getBrowserManager("cron-nightly");
    expect(chat).not.toBe(mission);
  });

  it("starts each session with no owned tabs and inactive", () => {
    const m = getBrowserManager("chat-1");
    expect(m.listOwnedPages()).toEqual([]);
    expect(m.isActive()).toBe(false);
  });

  it("closing one session leaves the other's manager untouched", async () => {
    const chat = getBrowserManager("chat-1");
    const mission = getBrowserManager("cron-nightly");
    await closeBrowser("chat-1");
    expect(getBrowserManager("chat-1")).not.toBe(chat);
    expect(getBrowserManager("cron-nightly")).toBe(mission);
  });
});

describe("per-session BrowserContext allocation", () => {
  beforeEach(() => {
    mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:43123" });
  });

  afterEach(async () => {
    await closeSharedBrowser();
    mocks.contexts.length = 0;
    vi.clearAllMocks();
  });

  it("gives two sessions distinct BrowserContexts by default", async () => {
    const isolatedByDefault = configSchema.parse({}).browserPerSessionContext;
    const chat = await acquireSessionContext("chromium", isolatedByDefault);
    const mission = await acquireSessionContext("chromium", isolatedByDefault);

    expect(chat).not.toBe(mission);
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(2);
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        proxy: { server: "http://127.0.0.1:43123", bypass: "<-loopback>" },
      }),
    );
  });

  it("honors explicit shared mode by reusing one BrowserContext", async () => {
    const chat = await acquireSessionContext("chromium", false);
    const mission = await acquireSessionContext("chromium", false);

    expect(chat).toBe(mission);
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(1);
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        proxy: { server: "http://127.0.0.1:43123", bypass: "<-loopback>" },
      }),
    );
  });

  it("does not hand the unconfigurable CDP default context to shared mode", async () => {
    const defaultContext = { id: Symbol("cdp-default") } as unknown as BrowserContext;
    mocks.contexts.push(defaultContext);

    const shared = await acquireSessionContext("chromium", false);

    expect(shared).not.toBe(defaultContext);
    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        proxy: { server: "http://127.0.0.1:43123", bypass: "<-loopback>" },
      }),
    );
  });

  it("fails closed before browser launch when proxy startup fails", async () => {
    mocks.startProxy.mockRejectedValueOnce(new Error("proxy bind failed"));

    await expect(acquireSessionContext("chromium", true)).rejects.toThrow("proxy bind failed");

    expect(mocks.browser.newContext).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent shared-context creation", async () => {
    const [chat, mission] = await Promise.all([
      acquireSessionContext("chromium", false),
      acquireSessionContext("chromium", false),
    ]);

    expect(chat).toBe(mission);
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(1);
  });
});
