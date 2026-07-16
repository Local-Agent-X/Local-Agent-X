// Browser dialogs (chunk F) — desktop-side beforeunload interception queue
// (desktop/src/browser-dialogs.ts), its will-prevent-unload semantics (queue
// by default = page stays; accept arms a ONE-SHOT preventDefault = next
// unload proceeds), the lax:browser-dialogs bridge op, and the lifecycle
// wiring through wireBrowserEgressEvaluator's composed observer. Hermetic:
// browser-dialogs is a pure leaf; electron-touching modules are mocked.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const h = vi.hoisted(() => ({
  viewsById: new Map<string, unknown>(),
  poolList: [] as unknown[],
  lifecycleObserver: null as null | {
    onViewCreated(viewId: string, wc: unknown, agentDriven: boolean): void;
    onViewClosed(viewId: string): void;
  },
}));

vi.mock("../desktop/src/browser-views", () => ({
  createBrowserView: () => ({}),
  closeBrowserView: () => {},
  getBrowserView: (viewId: string) => h.viewsById.get(viewId),
  listBrowserViews: () => h.poolList,
  pingBrowserView: () => ({ ok: true }),
  hideBrowserView: () => {},
  setBrowserViewBounds: () => {},
  showBrowserView: () => {},
  setViewLifecycleObserver: (obs: typeof h.lifecycleObserver) => { h.lifecycleObserver = obs; },
  setPoolChangedListener: () => {},
}));
vi.mock("../desktop/src/browser-partition", () => ({
  getHardenedPartitionSession: () => ({ clearStorageData: async () => {} }),
  setEgressEvaluator: () => {},
  setDownloadContextResolver: () => {},
  setDownloadDoneListener: () => {},
  listQuarantinedDownloads: () => [],
}));
vi.mock("../desktop/src/browser-ipc", () => ({ autoSurfaceAgentView: () => {} }));
vi.mock("../desktop/src/in-app-browser", () => ({
  isUserActive: () => false,
  markAgentInput: () => {},
  showAgentCursor: () => {},
}));

import {
  attachDialogInterception,
  detachDialogState,
  handleDialog,
  listDialogs,
  BEFOREUNLOAD_MESSAGE,
  MAX_PENDING_DIALOGS,
  _resetBrowserDialogsForTest,
} from "../desktop/src/browser-dialogs";
import { handleBrowserBridgeMessage, wireBrowserEgressEvaluator } from "../desktop/src/server-bridge-browser";

/** EventEmitter-ish fake webContents (same idiom as browser-perception.test.ts). */
function fakeWc() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    destroyed: false,
    isDestroyed(): boolean { return this.destroyed; },
    getURL: () => "https://example.com/",
    getTitle: () => "Example",
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return this;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return this;
    },
    fire(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    listenerCount(event: string): number { return listeners.get(event)?.size ?? 0; },
  };
}

/** A will-prevent-unload event whose preventDefault call is observable. */
function unloadEvent() {
  return { preventDefault: vi.fn() };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetBrowserDialogsForTest();
  h.viewsById.clear();
  h.poolList = [];
  h.lifecycleObserver = null;
});

describe("beforeunload interception queue (pure leaf)", () => {
  it("queues an interception WITHOUT preventDefault — the page stays blocked, never silently unloaded", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    const ev = unloadEvent();
    wc.fire("will-prevent-unload", ev);
    expect(ev.preventDefault).not.toHaveBeenCalled(); // default = keep page
    expect(listDialogs("v1")).toEqual([{ type: "beforeunload", message: BEFOREUNLOAD_MESSAGE }]);
  });

  it("accept arms a ONE-SHOT allow: the NEXT unload attempt is let through via preventDefault, then re-blocks", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    wc.fire("will-prevent-unload", unloadEvent());
    const handled = handleDialog("v1", "accept");
    expect(handled).toEqual({ type: "beforeunload", message: BEFOREUNLOAD_MESSAGE });
    expect(listDialogs("v1")).toEqual([]);
    // The retried unload proceeds (preventDefault ignores the page handler)…
    const retry = unloadEvent();
    wc.fire("will-prevent-unload", retry);
    expect(retry.preventDefault).toHaveBeenCalledTimes(1);
    expect(listDialogs("v1")).toEqual([]); // consumed, not queued
    // …and the allow was one-shot: a LATER attempt queues again.
    const later = unloadEvent();
    wc.fire("will-prevent-unload", later);
    expect(later.preventDefault).not.toHaveBeenCalled();
    expect(listDialogs("v1")).toHaveLength(1);
  });

  it("a STALE accept expires: the user's later unload guard is NOT swallowed (skeptic regression)", async () => {
    vi.useFakeTimers();
    try {
      const { UNLOAD_ALLOW_TTL_MS } = await import("../desktop/src/browser-dialogs.js");
      const wc = fakeWc();
      attachDialogInterception("v1", wc as never);
      wc.fire("will-prevent-unload", unloadEvent());
      handleDialog("v1", "accept"); // armed… but the agent never retries
      vi.advanceTimersByTime(UNLOAD_ALLOW_TTL_MS + 1);
      // Hours later the USER closes the tab with unsaved changes: the page's
      // guard must fire (no preventDefault), and the attempt queues normally.
      const userClose = unloadEvent();
      wc.fire("will-prevent-unload", userClose);
      expect(userClose.preventDefault).not.toHaveBeenCalled();
      expect(listDialogs("v1")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismiss drops the entry without arming the allow — the page keeps its guard", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    wc.fire("will-prevent-unload", unloadEvent());
    expect(handleDialog("v1", "dismiss")).toEqual({ type: "beforeunload", message: BEFOREUNLOAD_MESSAGE });
    const next = unloadEvent();
    wc.fire("will-prevent-unload", next);
    expect(next.preventDefault).not.toHaveBeenCalled(); // still blocking
    expect(listDialogs("v1")).toHaveLength(1);
  });

  it("handleDialog on an empty queue (or unknown view) returns null and never arms the allow", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    expect(handleDialog("v1", "accept")).toBeNull();
    expect(handleDialog("ghost", "accept")).toBeNull();
    const ev = unloadEvent();
    wc.fire("will-prevent-unload", ev);
    expect(ev.preventDefault).not.toHaveBeenCalled(); // the null accept armed nothing
  });

  it("the pending queue is bounded — oldest entries fall off", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    for (let i = 0; i < MAX_PENDING_DIALOGS + 3; i++) wc.fire("will-prevent-unload", unloadEvent());
    expect(listDialogs("v1")).toHaveLength(MAX_PENDING_DIALOGS);
  });

  it("detach clears state and removes the listener; late events neither throw nor resurrect the queue", () => {
    const wc = fakeWc();
    attachDialogInterception("v1", wc as never);
    wc.fire("will-prevent-unload", unloadEvent());
    detachDialogState("v1");
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
    expect(listDialogs("v1")).toEqual([]);
    expect(() => wc.fire("will-prevent-unload", unloadEvent())).not.toThrow();
    expect(listDialogs("v1")).toEqual([]);
  });
});

describe("lax:browser-dialogs bridge op + lifecycle wiring", () => {
  let proc: { send: Mock; connected: boolean; killed: boolean };

  beforeEach(() => {
    proc = { send: vi.fn(() => true), connected: true, killed: false };
  });

  it("wireBrowserEgressEvaluator's observer arms dialog interception per view and tears it down on close", () => {
    wireBrowserEgressEvaluator(proc as never);
    expect(h.lifecycleObserver).not.toBeNull();
    const wc = fakeWc();
    h.lifecycleObserver!.onViewCreated("view-s-1-work", wc as never, true);
    wc.fire("will-prevent-unload", unloadEvent());
    expect(listDialogs("view-s-1-work")).toHaveLength(1);
    h.lifecycleObserver!.onViewClosed("view-s-1-work");
    expect(listDialogs("view-s-1-work")).toEqual([]);
    expect(wc.listenerCount("will-prevent-unload")).toBe(0);
  });

  it("op list replies with the pending queue; accept/dismiss reply with the handled entry (null when empty)", async () => {
    const wc = fakeWc();
    h.viewsById.set("v1", { webContents: wc });
    attachDialogInterception("v1", wc as never);
    wc.fire("will-prevent-unload", unloadEvent());

    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-dialogs", id: 31, viewId: "v1", op: "list" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-dialogs-result", id: 31, ok: true,
      dialogs: [{ type: "beforeunload", message: BEFOREUNLOAD_MESSAGE }],
    }));

    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-dialogs", id: 32, viewId: "v1", op: "accept" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-dialogs-result", id: 32, ok: true,
      handled: { type: "beforeunload", message: BEFOREUNLOAD_MESSAGE },
    }));

    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-dialogs", id: 33, viewId: "v1", op: "dismiss" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-dialogs-result", id: 33, ok: true, handled: null,
    }));
  });

  it("an unknown view fails typed (ok:false), same law as the other ops", async () => {
    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-dialogs", id: 34, viewId: "ghost", op: "list" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-dialogs-result", id: 34, ok: false,
      error: expect.stringContaining('no browser view "ghost"'),
    }));
  });
});
