import { describe, it, expect, afterEach } from "vitest";
import { getBrowserManager, closeBrowser, closeAllBrowsers } from "./instance.js";

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
