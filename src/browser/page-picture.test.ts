import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browser = { navigate: vi.fn(), evaluate: vi.fn(), getCurrentUrl: vi.fn(() => "https://store.example/p") };
const opened: string[] = [];
const closed: string[] = [];

vi.mock("./instance.js", () => ({
  getBrowserManager: (sessionId: string) => { opened.push(sessionId); return browser; },
  closeBrowser: async (sessionId: string) => { closed.push(sessionId); },
}));
vi.mock("./route-resolve.js", () => ({ resolveBrowserRoute: vi.fn(() => ({ kind: "in-app" })) }));

import { PAGE_PICTURE_TIMEOUT_MS, firstPicture, pagePicture } from "./page-picture.js";
import { isBrowserOffScreen, _resetOffScreenSessions } from "./off-screen-sessions.js";
import { resolveBrowserRoute } from "./route-resolve.js";

beforeEach(() => {
  opened.length = 0;
  closed.length = 0;
  browser.navigate.mockReset().mockResolvedValue("Navigated");
  browser.evaluate.mockReset().mockResolvedValue(JSON.stringify([{ src: "https://cdn.example/p.jpg", alt: "P" }]));
});
afterEach(() => { _resetOffScreenSessions(); vi.useRealTimers(); });

describe("pagePicture", () => {
  it("reads the page's picture in its own off-screen session and closes it", async () => {
    let offScreenWhileOpen = false;
    browser.navigate.mockImplementation(async () => { offScreenWhileOpen = isBrowserOffScreen(opened[0]); return "ok"; });
    expect(await pagePicture("https://store.example/p", "chat-1")).toBe("https://cdn.example/p.jpg");
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toBe("chat-1");
    expect(offScreenWhileOpen).toBe(true);
    expect(closed).toEqual(opened);
    expect(isBrowserOffScreen(opened[0])).toBe(false);
  });

  it("closes the tab when the page fails to load", async () => {
    browser.navigate.mockRejectedValue(new Error("blocked"));
    expect(await pagePicture("https://store.example/p", "chat-1")).toBeNull();
    expect(closed).toEqual(opened);
  });

  it("gives up and closes the tab when the page hangs", async () => {
    vi.useFakeTimers();
    browser.navigate.mockImplementation(() => new Promise(() => {}));
    const p = pagePicture("https://store.example/p", "chat-1");
    await vi.advanceTimersByTimeAsync(PAGE_PICTURE_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(closed).toEqual(opened);
  });

  it("runs one lookup at a time", async () => {
    let release!: () => void;
    browser.navigate.mockImplementationOnce(() => new Promise((r) => { release = () => r("ok"); }));
    const first = pagePicture("https://a.example/", "chat-1");
    const second = pagePicture("https://b.example/", "chat-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toHaveLength(1);
    release();
    await first;
    await second;
    expect(opened).toHaveLength(2);
    expect(closed).toEqual(opened);
  });

  it("never opens a browser that would be a window on screen (no desktop app)", async () => {
    vi.mocked(resolveBrowserRoute).mockReturnValueOnce({ kind: "cdp", reason: "no-desktop-bridge" });
    expect(await pagePicture("https://store.example/p", "chat-1")).toBeNull();
    expect(opened).toHaveLength(0);
  });
});

describe("firstPicture", () => {
  it("takes the first listed picture, and nothing from garbage", () => {
    expect(firstPicture(JSON.stringify([{ src: "https://a/1.jpg" }, { src: "https://a/2.jpg" }]))).toBe("https://a/1.jpg");
    expect(firstPicture("[]")).toBeNull();
    expect(firstPicture("not json")).toBeNull();
  });
});
