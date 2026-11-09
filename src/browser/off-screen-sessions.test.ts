import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFF_SCREEN_IDLE_CLOSE_MS, _resetOffScreenSessions, awayFromDesktop, forgetOffScreenBrowser,
  isBrowserOffScreen, markBrowserOffScreen, noteBrowserSurface, touchOffScreenBrowser,
} from "./off-screen-sessions.js";
import { _resetSessionOwnerRegistry, registerChildSessionOwner } from "./session-owner-registry.js";

afterEach(() => {
  _resetOffScreenSessions();
  _resetSessionOwnerRegistry();
  vi.useRealTimers();
});

describe("awayFromDesktop", () => {
  it("the phone app, a call on the phone and the messaging bridges are away; the desktop is not", () => {
    expect(awayFromDesktop("mobile")).toBe(true);
    expect(awayFromDesktop("voice", "phone")).toBe(true);
    expect(awayFromDesktop("telegram")).toBe(true);
    expect(awayFromDesktop("web")).toBe(false);
    expect(awayFromDesktop("voice", "desktop")).toBe(false);
  });

  it("a turn nobody is watching leaves the mark as it was", () => {
    noteBrowserSurface("s1", "mobile");
    noteBrowserSurface("s1", "cron");
    expect(isBrowserOffScreen("s1")).toBe(true);
  });
});

describe("off-screen browser lifetime", () => {
  it("closes an off-screen session's browser once it sits unused, and each use restarts the wait", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    noteBrowserSurface("s1", "mobile");
    touchOffScreenBrowser("s1", close);
    vi.advanceTimersByTime(OFF_SCREEN_IDLE_CLOSE_MS - 1000);
    touchOffScreenBrowser("s1", close);
    vi.advanceTimersByTime(OFF_SCREEN_IDLE_CLOSE_MS - 1000);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(close).toHaveBeenCalledWith("s1");
  });

  it("never times out a session browsing at the desktop", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    noteBrowserSurface("s1", "web");
    touchOffScreenBrowser("s1", close);
    vi.advanceTimersByTime(OFF_SCREEN_IDLE_CLOSE_MS * 3);
    expect(close).not.toHaveBeenCalled();
  });

  it("the user coming back to the desktop on the same thread cancels the pending close", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    noteBrowserSurface("s1", "mobile");
    touchOffScreenBrowser("s1", close);
    noteBrowserSurface("s1", "web");
    vi.advanceTimersByTime(OFF_SCREEN_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(isBrowserOffScreen("s1")).toBe(false);
  });

  it("a browser closed another way leaves no timer behind", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    markBrowserOffScreen("s1");
    touchOffScreenBrowser("s1", close);
    forgetOffScreenBrowser("s1");
    vi.advanceTimersByTime(OFF_SCREEN_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
  });

  it("a sub-agent browses off screen with its parent", () => {
    registerChildSessionOwner("child-1", "parent-1");
    noteBrowserSurface("parent-1", "mobile");
    expect(isBrowserOffScreen("child-1")).toBe(true);
  });
});
