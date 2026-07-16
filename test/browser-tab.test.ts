// @vitest-environment happy-dom
// Browser tab (right sidebar) — the pane reserves space for a native
// WebContentsView overlay drawn by Electron main; browser-tab.js reports
// the anchor rect + visibility over window.desktop.browser and mirrors
// nav-state pushes into the address bar. These tests drive the real
// module source against a fake desktop bridge.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Main-process side (desktop/src/browser-ipc.ts) under mocked electron ──
// Captures ipcMain.handle registrations so handlers can be invoked with fake
// senders: only the MAIN window's webContents may drive the browser view.
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainWin: null as null | { isDestroyed(): boolean; webContents: unknown },
  fakeView: null as unknown,
  setBoundsCalls: [] as unknown[][],
  showCalls: 0,
  hideCalls: 0,
}));

// electron is installed only under desktop/node_modules — mock the resolved
// package path (a bare "electron" here wouldn't match the id browser-ipc.ts
// resolves to).
vi.mock("../desktop/node_modules/electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
}));
vi.mock("../desktop/src/window", () => ({ getMainWindow: () => h.mainWin }));
vi.mock("../desktop/src/browser-views", () => ({
  createBrowserView: () => {},
  getBrowserView: () => h.fakeView,
  hideBrowserView: () => { h.hideCalls++; },
  setBrowserViewBounds: (...args: unknown[]) => { h.setBoundsCalls.push(args); },
  showBrowserView: () => { h.showCalls++; },
}));

import { isTrustedBrowserSender, scaleRectToDip, setupBrowserIPC } from "../desktop/src/browser-ipc";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeBridge {
  setBounds: Mock;
  setVisible: Mock;
  navigate: Mock;
  goBack: Mock;
  goForward: Mock;
  reload: Mock;
  getNavState: Mock;
  onNavState: Mock;
}

let bridge: FakeBridge;
let navStateCb: ((state: unknown) => void) | null;

function setAnchorRect(rect: { left: number; top: number; width: number; height: number }) {
  const anchor = document.getElementById("browser-view-anchor")!;
  (anchor as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="agent-feeds" class="agent-feeds">
      <div class="agent-feeds-header">
        <button class="side-panel-tab active" id="side-tab-agents"></button>
        <button class="side-panel-tab" id="side-tab-artifacts"></button>
        <button class="side-panel-tab" id="side-tab-browser"></button>
        <button id="agent-feeds-autoopen-toggle"></button>
      </div>
      <div id="agents-tab-body" class="side-tab-body"></div>
      <div id="artifacts-tab-body" class="side-tab-body" style="display:none"></div>
      <div id="browser-tab-body" class="side-tab-body" style="display:none">
        <div id="browser-address-bar">
          <button id="browser-nav-back" disabled></button>
          <button id="browser-nav-fwd" disabled></button>
          <button id="browser-nav-reload"></button>
          <input id="browser-url-input" type="text">
          <div id="browser-view-switcher-slot"></div>
        </div>
        <div id="browser-view-anchor"></div>
      </div>
    </div>`;

  navStateCb = null;
  bridge = {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    getNavState: vi.fn().mockResolvedValue({
      url: "", title: "", canGoBack: false, canGoForward: false, loading: false,
    }),
    onNavState: vi.fn((cb: (state: unknown) => void) => { navStateCb = cb; }),
  };
  (window as unknown as { desktop: unknown }).desktop = { isDesktop: true, browser: bridge };

  // happy-dom has no real layout, so hit-testing is stubbed: by default the
  // anchor wins (unoccluded); the occlusion tests override this.
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
    .elementFromPoint = () => document.getElementById("browser-view-anchor");

  const artifactsSrc = readFileSync(join(here, "../public/js/chat-artifacts.js"), "utf8");
  new Function(`${artifactsSrc}\nwindow.switchSidePanelTab = switchSidePanelTab;`)();
  const browserTabSrc = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");
  new Function(browserTabSrc)();
});

describe("browser tab in the right side panel", () => {
  it("switchSidePanelTab('browser') shows the pane and enters the browser tab", () => {
    const onTabShown = vi.spyOn(window.laxBrowserTab, "onTabShown");
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.switchSidePanelTab("browser");
    expect(document.getElementById("browser-tab-body")!.style.display).toBe("");
    expect(document.getElementById("agents-tab-body")!.style.display).toBe("none");
    expect(document.getElementById("side-tab-browser")!.classList.contains("active")).toBe(true);
    expect(onTabShown).toHaveBeenCalledTimes(1);
    // AUTO toggle belongs to the agents tab only.
    expect(document.getElementById("agent-feeds-autoopen-toggle")!.style.display).toBe("none");
  });

  it("leaving the tab calls onTabHidden and hides the overlay", () => {
    const onTabHidden = vi.spyOn(window.laxBrowserTab, "onTabHidden");
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.switchSidePanelTab("browser");
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    window.switchSidePanelTab("agents");
    expect(onTabHidden).toHaveBeenCalledTimes(1);
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    expect(document.getElementById("browser-tab-body")!.style.display).toBe("none");
  });

  it("reports the anchor rect as window-relative bounds when shown", () => {
    setAnchorRect({ left: 612.4, top: 41.6, width: 379.5, height: 502.2 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setBounds).toHaveBeenCalledWith({ x: 612, y: 42, width: 380, height: 502 });
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("a zero-size anchor rect hides the view instead of reporting 0-bounds", () => {
    setAnchorRect({ left: 0, top: 0, width: 0, height: 0 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setBounds).not.toHaveBeenCalled();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
  });

  it("collapsing the panel hides the overlay even while the tab is active", () => {
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    document.getElementById("agent-feeds")!.classList.add("collapsed");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    // Re-opening the panel shows it again.
    document.getElementById("agent-feeds")!.classList.remove("collapsed");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("Enter in the address bar navigates, prepending https:// to bare hosts", () => {
    const input = document.getElementById("browser-url-input") as HTMLInputElement;
    input.value = "example.com/docs";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(bridge.navigate).toHaveBeenCalledWith("https://example.com/docs");

    input.value = "http://plain.test";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(bridge.navigate).toHaveBeenLastCalledWith("http://plain.test");
  });

  it("hides the overlay while a full-screen DOM overlay covers the pane", () => {
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    // A fixed inset-0 overlay (global search / shortcuts / agent detail)
    // now wins hit-testing at the anchor's center.
    const overlay = document.createElement("div");
    overlay.id = "global-search-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:20000";
    document.body.appendChild(overlay);
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => overlay;
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    // Overlay closed → anchor wins again → view returns.
    overlay.remove();
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint =
      () => document.getElementById("browser-view-anchor");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("a hit on the anchor's own descendant counts as unoccluded", () => {
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    const child = document.createElement("div");
    document.getElementById("browser-view-anchor")!.appendChild(child);
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => child;
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("nav-state pushes update the URL field and button disabled states", () => {
    expect(navStateCb).toBeTypeOf("function");
    navStateCb!({
      url: "https://example.com/", title: "Example",
      canGoBack: true, canGoForward: false, loading: false,
    });
    expect((document.getElementById("browser-url-input") as HTMLInputElement).value)
      .toBe("https://example.com/");
    expect((document.getElementById("browser-nav-back") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("browser-nav-fwd") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("browser IPC main-process guards (browser-ipc.ts)", () => {
  let zoom: number;
  let trustedWC: { getZoomFactor(): number; send: Mock };
  let fakeWC: {
    isDestroyed(): boolean; isLoading(): boolean; getURL(): string; getTitle(): string;
    loadURL: Mock; reload: Mock; on: Mock;
    navigationHistory: { canGoBack(): boolean; canGoForward(): boolean; goBack: Mock; goForward: Mock };
  };

  beforeEach(() => {
    zoom = 1;
    trustedWC = { getZoomFactor: () => zoom, send: vi.fn() };
    h.mainWin = { isDestroyed: () => false, webContents: trustedWC };
    fakeWC = {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => "https://private.example/page",
      getTitle: () => "Private",
      loadURL: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
      on: vi.fn(),
      navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
    };
    h.fakeView = { webContents: fakeWC };
    h.setBoundsCalls = [];
    h.showCalls = 0;
    h.hideCalls = 0;
    h.handlers.clear();
    setupBrowserIPC();
  });

  it("scaleRectToDip converts zoomed CSS px to window DIPs", () => {
    const rect = { x: 100, y: 40, width: 381, height: 500 };
    expect(scaleRectToDip(rect, 1)).toEqual(rect);
    expect(scaleRectToDip(rect, 1.2)).toEqual({ x: 120, y: 48, width: 457, height: 600 });
    expect(scaleRectToDip(rect, 0.8)).toEqual({ x: 80, y: 32, width: 305, height: 400 });
  });

  it("browser-set-bounds scales by the main window's content zoom factor", () => {
    zoom = 1.25;
    h.handlers.get("browser-set-bounds")!({ sender: trustedWC }, { x: 100, y: 40, width: 400, height: 600 });
    expect(h.setBoundsCalls).toEqual([["foreground", { x: 125, y: 50, width: 500, height: 750 }]]);
  });

  it("isTrustedBrowserSender accepts only the live main window's webContents", () => {
    expect(isTrustedBrowserSender(trustedWC as never)).toBe(true);
    expect(isTrustedBrowserSender({} as never)).toBe(false);
    h.mainWin = null;
    expect(isTrustedBrowserSender(trustedWC as never)).toBe(false);
  });

  it("untrusted senders (child app windows) cannot act or read nav state", async () => {
    const appWindowWC = {}; // /apps/<id> windows share the preload but not trust
    h.handlers.get("browser-set-bounds")!({ sender: appWindowWC }, { x: 0, y: 0, width: 500, height: 500 });
    expect(h.setBoundsCalls).toEqual([]);
    h.handlers.get("browser-set-visible")!({ sender: appWindowWC }, true);
    expect(h.showCalls).toBe(0);
    await h.handlers.get("browser-navigate")!({ sender: appWindowWC }, "https://evil.example/");
    expect(fakeWC.loadURL).not.toHaveBeenCalled();
    h.handlers.get("browser-go-back")!({ sender: appWindowWC });
    expect(fakeWC.navigationHistory.goBack).not.toHaveBeenCalled();
    h.handlers.get("browser-reload")!({ sender: appWindowWC });
    expect(fakeWC.reload).not.toHaveBeenCalled();
    expect(h.handlers.get("browser-get-nav-state")!({ sender: appWindowWC })).toBeNull();
  });

  it("the trusted sender still gets full nav state and can navigate", async () => {
    expect(h.handlers.get("browser-get-nav-state")!({ sender: trustedWC })).toEqual({
      viewId: "foreground",
      url: "https://private.example/page",
      title: "Private",
      canGoBack: true,
      canGoForward: false,
      loading: false,
    });
    await h.handlers.get("browser-navigate")!({ sender: trustedWC }, "https://example.com/");
    expect(fakeWC.loadURL).toHaveBeenCalledWith("https://example.com/");
  });
});

declare global {
  interface Window {
    switchSidePanelTab(tab: string): void;
    laxBrowserTab: {
      onTabShown(): void;
      onTabHidden(): void;
      sync(): void;
      goBack(): void;
      goForward(): void;
      reload(): void;
      navigateFromInput(): void;
    };
  }
}
