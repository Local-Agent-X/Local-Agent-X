import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { WindowsChatChromeRuntime, windowsChatChromeProfileDir } from "./windows-chat-chrome-runtime.js";
import type { ProfileLaunchOptions } from "./launcher.js";

const originalDataDir = process.env.LAX_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = originalDataDir;
});

function runtimeFixture(sessionId: string, port: number) {
  const context = { pages: vi.fn(() => []) } as unknown as BrowserContext;
  const closeBrowser = vi.fn(async () => undefined);
  const browser = {
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(),
    isConnected: vi.fn(() => true),
    close: closeBrowser,
  } as unknown as Browser;
  const cleanup = vi.fn(async () => undefined);
  const closeProxy = vi.fn(async () => undefined);
  const launches: ProfileLaunchOptions[] = [];
  const launch = vi.fn(async (
    _pw: typeof import("playwright"),
    _proxyServer: string,
    options: ProfileLaunchOptions = {},
  ) => {
    launches.push(options);
    return { browser, chromeProcess: null, cleanup };
  });
  const runtime = new WindowsChatChromeRuntime(sessionId, undefined, {
    startProxy: vi.fn(async () => ({ url: `http://127.0.0.1:${port + 1000}`, close: closeProxy })),
    allocatePort: vi.fn(async () => port),
    loadPlaywright: vi.fn(async () => ({} as typeof import("playwright"))),
    launch,
  });
  return { runtime, context, browser, launch, launches, cleanup, closeBrowser, closeProxy };
}

describe("WindowsChatChromeRuntime", () => {
  it("derives a stable opaque persistent profile path per resolved chat", () => {
    process.env.LAX_DATA_DIR = "C:\\lax-test";
    const first = windowsChatChromeProfileDir("chat/one");
    expect(first).toBe(windowsChatChromeProfileDir("chat/one"));
    expect(first).not.toBe(windowsChatChromeProfileDir("chat/two"));
    expect(first).not.toContain("chat/one");
    expect(first).toContain("chrome-chat-profiles");
  });

  it("launches each chat on its own port, process, and user-data-dir", async () => {
    const one = runtimeFixture("chat-one", 18001);
    const two = runtimeFixture("chat-two", 18002);
    await Promise.all([
      one.runtime.acquire("chromium", "in-app", "chat-one"),
      two.runtime.acquire("chromium", "in-app", "chat-two"),
    ]);
    const oneOptions = one.launches[0];
    const twoOptions = two.launches[0];
    expect(oneOptions.cdpPort).toBe(18001);
    expect(twoOptions.cdpPort).toBe(18002);
    expect(oneOptions.userDataDir).not.toBe(twoOptions.userDataDir);
    expect(oneOptions.persistentDataDir).toBe(oneOptions.userDataDir);
    expect(twoOptions.persistentDataDir).toBe(twoOptions.userDataDir);
    expect(oneOptions.forceProfileLaunch).toBe(true);
  });

  it("uses Chrome's persistent default context rather than an incognito context", async () => {
    const fixture = runtimeFixture("chat-one", 18001);
    await expect(fixture.runtime.acquire("chromium", "in-app", "chat-one")).resolves.toBe(fixture.context);
    expect(fixture.browser.newContext).not.toHaveBeenCalled();
  });

  it("release closes only that chat's browser, process cleanup, and proxy", async () => {
    const one = runtimeFixture("chat-one", 18001);
    const two = runtimeFixture("chat-two", 18002);
    const oneContext = await one.runtime.acquire("chromium", "in-app", "chat-one");
    await two.runtime.acquire("chromium", "in-app", "chat-two");
    await one.runtime.release(oneContext, "in-app");
    expect(one.closeBrowser).toHaveBeenCalledOnce();
    expect(one.cleanup).toHaveBeenCalledOnce();
    expect(one.closeProxy).toHaveBeenCalledOnce();
    expect(two.closeBrowser).not.toHaveBeenCalled();
    expect(two.cleanup).not.toHaveBeenCalled();
  });

  it("reset kills only its own process and can relaunch with the same profile", async () => {
    const fixture = runtimeFixture("chat-one", 18001);
    await fixture.runtime.acquire("chromium", "in-app", "chat-one");
    const profile = fixture.runtime.profileDir;
    await fixture.runtime.reset();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    await fixture.runtime.acquire("chromium", "in-app", "chat-one");
    expect(fixture.launch).toHaveBeenCalledTimes(2);
    expect(fixture.launches[1].userDataDir).toBe(profile);
  });
});
