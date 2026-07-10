import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => {
  const contexts: BrowserContext[] = [];
  const browser = {
    isConnected: () => true,
    contexts: () => contexts,
    newContext: vi.fn(async () => {
      const context = {
        id: Symbol("context"),
        close: vi.fn(async () => undefined),
        storageState: vi.fn(async (options?: { path?: string; indexedDB?: boolean }) => {
          if (options?.path) writeFileSync(options.path, JSON.stringify({ cookies: [], origins: [] }));
          return { cookies: [], origins: [] };
        }),
      } as unknown as BrowserContext;
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
import { acquireSessionContext, closeSharedBrowser, releaseSessionContext } from "./runtime.js";
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
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "browser-mode-runtime-"));
    process.env.LAX_DATA_DIR = dataDir;
    mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:43123" });
  });

  afterEach(async () => {
    await closeSharedBrowser();
    mocks.contexts.length = 0;
    vi.clearAllMocks();
    delete process.env.LAX_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("gives two sessions distinct BrowserContexts by default", async () => {
    const isolatedByDefault = configSchema.parse({}).browserMode;
    const chat = await acquireSessionContext("chromium", isolatedByDefault, "chat");
    const mission = await acquireSessionContext("chromium", isolatedByDefault, "mission");

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
    const chat = await acquireSessionContext("chromium", "advanced-shared", "chat");
    const mission = await acquireSessionContext("chromium", "advanced-shared", "mission");

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

    const shared = await acquireSessionContext("chromium", "advanced-shared", "chat");

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

    await expect(acquireSessionContext("chromium", "isolated", "chat")).rejects.toThrow("proxy bind failed");

    expect(mocks.browser.newContext).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent shared-context creation", async () => {
    const [chat, mission] = await Promise.all([
      acquireSessionContext("chromium", "advanced-shared", "chat"),
      acquireSessionContext("chromium", "advanced-shared", "mission"),
    ]);

    expect(chat).toBe(mission);
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(1);
  });

  it("hands continuity identity between owners without sharing a live context", async () => {
    const chat = await acquireSessionContext("chromium", "continuity", "chat");
    const mission = await acquireSessionContext("chromium", "continuity", "mission");
    const statePath = join(dataDir, "browser-continuity-state.json");

    expect(mission).not.toBe(chat);
    expect(chat.storageState).toHaveBeenCalledWith({ path: `${statePath}.tmp`, indexedDB: true });
    expect(chat.close).toHaveBeenCalledOnce();
    expect(existsSync(statePath)).toBe(true);
    expect(mocks.browser.newContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ storageState: statePath }),
    );
  });

  it("reuses continuity context only for the same owner", async () => {
    const first = await acquireSessionContext("chromium", "continuity", "chat");
    const second = await acquireSessionContext("chromium", "continuity", "chat");

    expect(second).toBe(first);
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(1);
  });

  it("lets a previous owner close cleanly after continuity has handed off", async () => {
    const chat = await acquireSessionContext("chromium", "continuity", "chat");
    await acquireSessionContext("chromium", "continuity", "mission");
    vi.mocked(chat.storageState).mockClear();

    await expect(releaseSessionContext(chat, "continuity")).resolves.toBeUndefined();

    expect(chat.storageState).not.toHaveBeenCalled();
    expect(chat.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the current continuity owner live and surfaces a failed handoff save", async () => {
    const chat = await acquireSessionContext("chromium", "continuity", "chat");
    vi.mocked(chat.storageState).mockRejectedValueOnce(new Error("disk full"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(acquireSessionContext("chromium", "continuity", "mission"))
      .rejects.toThrow("Could not save the dedicated continuity browser identity: disk full");

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("continuity state save failed: disk full"));
    errorLog.mockRestore();
    expect(chat.close).not.toHaveBeenCalled();
    expect(mocks.browser.newContext).toHaveBeenCalledTimes(1);
    expect(await acquireSessionContext("chromium", "continuity", "chat")).toBe(chat);
  });

  it("refuses continuity teardown when durable state cannot be saved", async () => {
    const chat = await acquireSessionContext("chromium", "continuity", "chat");
    vi.mocked(chat.storageState).mockRejectedValueOnce(new Error("permission denied"));

    await expect(releaseSessionContext(chat, "continuity"))
      .rejects.toThrow("Could not save the dedicated continuity browser identity: permission denied");

    expect(chat.close).not.toHaveBeenCalled();
    expect(await acquireSessionContext("chromium", "continuity", "chat")).toBe(chat);
  });
});
