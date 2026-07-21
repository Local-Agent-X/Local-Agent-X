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
  chatOverlayCalls: [] as unknown[][],
  // Multi-view pool state for the mocked browser-views module: id-aware view
  // lookup (falls back to fakeView for ids the test didn't register), the
  // attached-view answer, the captured pool-change listener, and the list
  // returned by listBrowserViews.
  viewsById: new Map<string, unknown>(),
  createCalls: [] as unknown[][],
  closeCalls: [] as string[],
  attachedId: null as string | null,
  poolListener: null as null | (() => void),
  poolList: [] as unknown[],
  trustResolver: null as null | ((id: number) => "user" | "agent" | null),
}));

// Root Vitest resolves Electron to its test-only alias; desktop's own config
// retains the real Electron package for desktop coverage.
vi.mock("electron", () => {
  let wcIdSeq = 100;
  return {
    shell: { openExternal: vi.fn() },
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    // Used only by the REAL browser-views module (vi.importActual below).
    WebContentsView: class {
      webContents = {
        id: ++wcIdSeq,
        isDestroyed: () => false,
        close: () => {},
        getURL: () => "",
        getTitle: () => "",
        loadURL: () => Promise.resolve(),
        send: () => {},
        setWindowOpenHandler: () => {},
        on: () => {},
      };
      setBounds() {}
      setBackgroundColor() {}
      setBorderRadius() {}
    },
  };
});
vi.mock("../desktop/src/window", () => ({ getMainWindow: () => h.mainWin }));
vi.mock("../desktop/src/browser-views", () => ({
  createBrowserView: (viewId: string, opts: unknown) => {
    h.createCalls.push([viewId, opts]);
    // Auto-register a live fake view, mimicking the pool.
    if (!h.viewsById.has(viewId)) {
      h.viewsById.set(viewId, {
        webContents: {
          url: "",
          isDestroyed() { return false; },
          isLoading() { return false; },
          getURL() { return (this as unknown as { url: string }).url; },
          getTitle() { return ""; },
          loadURL(u: string) { (this as unknown as { url: string }).url = u; return Promise.resolve(); },
          on() {},
          off() {},
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        },
      });
    }
  },
  closeBrowserView: (viewId: string) => { h.closeCalls.push(viewId); },
  getBrowserView: (viewId: string) => (h.viewsById.has(viewId) ? h.viewsById.get(viewId) : h.fakeView),
  getAttachedViewId: () => h.attachedId,
  setPoolChangedListener: (fn: (() => void) | null) => { h.poolListener = fn; },
  listBrowserViews: () => h.poolList,
  pingBrowserView: () => ({ ok: true }),
  hideBrowserView: () => { h.hideCalls++; },
  setBrowserChatOverlay: (...args: unknown[]) => { h.chatOverlayCalls.push(args); },
  setBrowserViewBounds: (...args: unknown[]) => { h.setBoundsCalls.push(args); },
  showBrowserView: () => { h.showCalls++; },
}));
// server-bridge-browser + the REAL browser-views pull these in; keep them inert.
vi.mock("../desktop/src/browser-partition", () => ({
  getHardenedPartitionSession: () => ({ clearStorageData: async () => {} }),
  hardenWebContents: () => {},
  viewWebPreferences: () => ({}),
  setEgressEvaluator: () => {},
  setViewTrustResolver: (fn: ((id: number) => "user" | "agent" | null) | null) => { h.trustResolver = fn; },
  // Chunk F seams (browser-downloads-bridge wires these on every respawn).
  setDownloadContextResolver: () => {},
  setDownloadDoneListener: () => {},
  listQuarantinedDownloads: () => [],
}));
vi.mock("../desktop/src/browser-view-popups", () => ({
  managePopups: () => ({ closeAll: () => {} }),
}));
vi.mock("../desktop/src/in-app-browser", () => ({
  armCoDrive: () => {},
  isUserActive: () => false,
  markAgentInput: () => {},
  showAgentCursor: () => {},
}));
// Partial mock: real browser-ipc behavior, but autoSurfaceAgentView wrapped in
// a spy so the server-bridge hook can be asserted while still executing the
// real policy against the mocked pool.
vi.mock("../desktop/src/browser-ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/src/browser-ipc")>();
  return { ...actual, autoSurfaceAgentView: vi.fn(actual.autoSurfaceAgentView) };
});

import { autoSurfaceAgentView, isTrustedBrowserSender, scaleRectToDip, setupBrowserIPC } from "../desktop/src/browser-ipc";
import { handleBrowserBridgeMessage } from "../desktop/src/server-bridge-browser";

// The REAL pool module (mocked deps): exercises getAttachedViewId + the
// pool-change listener seam against actual pool state.
const realViews = await vi.importActual<typeof import("../desktop/src/browser-views")>(
  "../desktop/src/browser-views",
);

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
  // Strip module first, then the tab module — same order as app.html.
  const stripSrc = readFileSync(join(here, "../public/js/browser-tab-strip.js"), "utf8");
  new Function(stripSrc)();
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

  it("hides the overlay when a dropdown covers only a CORNER of the pane", () => {
    // Regression: the titlebar ⋯ menu drapes over the top corner of the
    // browser pane — never its center — so a center-only occlusion probe
    // missed it and the menu rendered stuck behind the native view.
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    const menu = document.createElement("div");
    menu.className = "dtb-dd";
    document.body.appendChild(menu);
    // Hit-testing: the menu wins only in the pane's top-left region.
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = (x, y) =>
        x < 800 && y < 200 ? menu : document.getElementById("browser-view-anchor");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    // Menu closed → all probes resolve to the anchor → view returns.
    menu.remove();
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint =
      () => document.getElementById("browser-view-anchor");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("hides the overlay when a dropdown drapes over the top edge but misses every corner", () => {
    // Regression #2: the titlebar ⋯ menu is right-aligned to the ⋯ button,
    // which sits LEFT of the agents-toggle + window caption buttons — so the
    // menu covers a strip of the pane's top edge that stops ~40px short of
    // the top-right corner and nowhere near the center. The old fixed
    // 5-point probe (center + 4 inset corners) missed it and the menu
    // rendered stuck behind the native view. The probe grid walks the whole
    // perimeter, so any ≥60px run across an edge is caught.
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    const menu = document.createElement("div");
    menu.className = "dtb-dd";
    document.body.appendChild(menu);
    // Menu covers x∈[820,940], y∈[40,240] — anchor corners are at x=612/968,
    // y=52/528 and the center at (790,290): none of the legacy points hit.
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = (x, y) =>
        x >= 820 && x <= 940 && y >= 40 && y <= 240
          ? menu
          : document.getElementById("browser-view-anchor");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    // Menu closed → view returns.
    menu.remove();
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint =
      () => document.getElementById("browser-view-anchor");
    window.laxBrowserTab.sync();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("corner probes are inset past edge chrome like the 5px resize handle", () => {
    // The panel resize handle permanently overlaps the pane's left edge; if a
    // corner probe landed on it, the view would hide forever. Probes must sit
    // deeper than the handle's 5px strip.
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    const handle = document.createElement("div");
    handle.className = "agent-feeds-resize-handle";
    document.body.appendChild(handle);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = (x) =>
        x < 605 ? handle : document.getElementById("browser-view-anchor");
    window.laxBrowserTab.onTabShown();
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

  it("a failed load hides the native view and shows the error card; Retry reloads", () => {
    // Regression: a dead local server (ComfyUI stopped, dev server down) or an
    // egress-blocked page left the pane silently WHITE — the native view renders
    // a blank error document and nothing told the user what happened.
    setAnchorRect({ left: 600, top: 40, width: 380, height: 500 });
    window.laxBrowserTab.onTabShown();
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);

    navStateCb!({
      url: "http://127.0.0.1:8188/", title: "", canGoBack: false, canGoForward: false, loading: false,
      loadError: { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:8188/" },
    });
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false);
    const anchor = document.getElementById("browser-view-anchor")!;
    expect(anchor.textContent).toContain("Can't reach this page");
    expect(anchor.textContent).toContain("ERR_CONNECTION_REFUSED");
    expect(anchor.textContent).toContain("http://127.0.0.1:8188/");

    document.getElementById("browser-load-error-retry")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.reload).toHaveBeenCalledTimes(1);

    // The retry's load-start clears the error → card gone, view returns.
    navStateCb!({
      url: "http://127.0.0.1:8188/", title: "", canGoBack: false, canGoForward: false, loading: true,
      loadError: null,
    });
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
    expect(document.getElementById("browser-load-error-retry")).toBeNull();
    expect(anchor.textContent).not.toContain("Can't reach this page");
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
    trustedWC = {
      getZoomFactor: () => zoom,
      getURL: () => "http://127.0.0.1:7007/?token=test",
      send: vi.fn(),
    };
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
    h.chatOverlayCalls = [];
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

  it("keeps the Browser visible behind the native full-page chat overlay", () => {
    setAnchorRect({ left: 0, top: 80, width: 1200, height: 640 });
    document.body.classList.add("browser-workspace");
    const chat = document.createElement("div");
    chat.id = "chat-main";
    document.body.appendChild(chat);
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => chat;

    window.laxBrowserTab.onTabShown();

    expect(bridge.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("bounds the chat overlay to its card and rejects a foreign overlay origin", () => {
    zoom = 1.25;
    const payload = {
      bounds: { x: 560, y: 620, width: 840, height: 380 },
      overlayUrl: "http://127.0.0.1:7007/?token=test&browserChatOverlay=1#chat",
      sessionId: "chat-1",
      collapsed: false,
      latestOpen: true,
    };
    h.handlers.get("browser-set-chat-overlay")!({ sender: trustedWC }, payload);
    expect(h.chatOverlayCalls).toEqual([[
      { x: 700, y: 775, width: 1050, height: 475 },
      { sessionId: "chat-1", collapsed: false, latestOpen: true },
      "http://127.0.0.1:7007/?token=test&browserChatOverlay=1#chat",
    ]]);

    h.chatOverlayCalls = [];
    h.handlers.get("browser-set-chat-overlay")!({ sender: trustedWC }, {
      ...payload,
      overlayUrl: "https://evil.example/?browserChatOverlay=1",
    });
    expect(h.chatOverlayCalls).toEqual([]);
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

  it("main-frame load failures surface in nav-state and clear on the next load", async () => {
    // Navigating wires nav pushes (incl. did-fail-load) onto the webContents.
    await h.handlers.get("browser-navigate")!({ sender: trustedWC }, "http://127.0.0.1:8188/");
    const handlerFor = (ev: string) =>
      (fakeWC.on as Mock).mock.calls.filter((c) => c[0] === ev).map((c) => c[1] as (...a: unknown[]) => void);
    const [onFail] = handlerFor("did-fail-load");
    const [onStart] = handlerFor("did-start-loading");
    expect(onFail).toBeTypeOf("function");
    expect(onStart).toBeTypeOf("function");

    // Subframe failures and ERR_ABORTED (-3, redirects/rapid re-nav) are
    // normal browsing — never surfaced as a load error.
    onFail({}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8188/", false);
    onFail({}, -3, "ERR_ABORTED", "http://127.0.0.1:8188/", true);
    expect(trustedWC.send).not.toHaveBeenCalledWith(
      "browser-nav-state",
      expect.objectContaining({ loadError: expect.anything() }),
    );

    onFail({}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8188/", true);
    expect(trustedWC.send).toHaveBeenLastCalledWith(
      "browser-nav-state",
      expect.objectContaining({
        loadError: { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:8188/" },
      }),
    );

    // A retry/navigation clears the failure the moment the load starts.
    onStart();
    expect(trustedWC.send).toHaveBeenLastCalledWith(
      "browser-nav-state",
      expect.objectContaining({ loadError: null }),
    );
  });

  it("the trusted sender still gets full nav state and can navigate", async () => {
    expect(h.handlers.get("browser-get-nav-state")!({ sender: trustedWC })).toEqual({
      viewId: "foreground",
      url: "https://private.example/page",
      title: "Private",
      canGoBack: true,
      canGoForward: false,
      loading: false,
      loadError: null,
    });
    await h.handlers.get("browser-navigate")!({ sender: trustedWC }, "https://example.com/");
    expect(fakeWC.loadURL).toHaveBeenCalledWith("https://example.com/");
  });
});

// ── Auto-surface, new-tab, views-changed, close guard ─────────────

/** Live fake webContents whose URL tracks loadURL — enough for nav-state reads. */
function makeWc(url = "") {
  const wc = {
    url,
    destroyed: false,
    loads: [] as string[],
    isDestroyed: () => wc.destroyed,
    isLoading: () => false,
    getURL: () => wc.url,
    getTitle: () => "",
    loadURL: (u: string) => { wc.url = u; wc.loads.push(u); return Promise.resolve(); },
    reload: () => {},
    stop: () => {},
    on: () => {},
    off: () => {},
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return wc;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function viewsChangedCount(send: Mock): number {
  return send.mock.calls.filter((c) => c[0] === "browser-views-changed").length;
}

function agentSurfacedCalls(send: Mock): unknown[] {
  return send.mock.calls.filter((c) => c[0] === "browser-agent-surfaced").map((c) => c[1]);
}

describe("auto-surface + new-tab (browser-ipc.ts)", () => {
  let trustedWC: { getZoomFactor(): number; send: Mock };
  let fgWc: ReturnType<typeof makeWc>;

  beforeEach(async () => {
    trustedWC = { getZoomFactor: () => 1, send: vi.fn() };
    h.mainWin = { isDestroyed: () => false, webContents: trustedWC };
    h.viewsById.clear();
    h.poolList = [];
    h.createCalls = [];
    h.closeCalls = [];
    h.attachedId = null;
    h.setBoundsCalls = [];
    h.showCalls = 0;
    h.handlers.clear();
    setupBrowserIPC();
    // Reset module state deterministically: current view = foreground (blank),
    // lastBoundsDip = a known rect.
    fgWc = makeWc("");
    h.viewsById.set("foreground", { webContents: fgWc });
    h.handlers.get("browser-switch-view")!({ sender: trustedWC }, "foreground");
    h.handlers.get("browser-set-bounds")!({ sender: trustedWC }, { x: 10, y: 20, width: 300, height: 400 });
    await flush(); // drain any queued views-changed poke from earlier pool churn
    h.setBoundsCalls = [];
    h.showCalls = 0;
    trustedWC.send.mockClear();
    (autoSurfaceAgentView as unknown as Mock).mockClear();
  });

  function currentNavViewId(): string {
    return (h.handlers.get("browser-get-nav-state")!({ sender: trustedWC }) as { viewId: string }).viewId;
  }

  it("retargets a blank foreground to the agent view and attaches when something was attached", async () => {
    h.viewsById.set("agent-7", { webContents: makeWc("https://agent.example/run") });
    h.attachedId = "foreground";
    autoSurfaceAgentView("agent-7");
    expect(currentNavViewId()).toBe("agent-7");
    expect(h.showCalls).toBe(1);
    expect(h.setBoundsCalls).toEqual([["agent-7", { x: 10, y: 20, width: 300, height: 400 }]]);
    expect(trustedWC.send).toHaveBeenCalledWith(
      "browser-nav-state",
      expect.objectContaining({ viewId: "agent-7", url: "https://agent.example/run" }),
    );
    // Surfacing pushes the renderer to bring the Browser tab up.
    expect(agentSurfacedCalls(trustedWC.send)).toEqual([{ viewId: "agent-7" }]);
    await flush();
    expect(viewsChangedCount(trustedWC.send)).toBe(1);
  });

  it("retargets WITHOUT attaching when nothing was attached (non-browser tab stays visible)", async () => {
    h.viewsById.set("agent-7", { webContents: makeWc("https://agent.example/run") });
    h.attachedId = null;
    autoSurfaceAgentView("agent-7");
    expect(currentNavViewId()).toBe("agent-7");
    expect(h.showCalls).toBe(0);
    expect(h.setBoundsCalls).toEqual([]);
    // Still surfaced: the push is what flips the renderer to the Browser tab,
    // whose onTabShown → set-visible is what actually attaches the view.
    expect(agentSurfacedCalls(trustedWC.send)).toEqual([{ viewId: "agent-7" }]);
    await flush();
    expect(viewsChangedCount(trustedWC.send)).toBe(1);
  });

  it("never steals a foreground showing a real URL — views-changed poke only", async () => {
    fgWc.url = "https://real.example/reading";
    h.viewsById.set("agent-7", { webContents: makeWc("https://agent.example/run") });
    h.attachedId = "foreground";
    autoSurfaceAgentView("agent-7");
    expect(currentNavViewId()).toBe("foreground");
    expect(h.showCalls).toBe(0);
    expect(trustedWC.send).not.toHaveBeenCalledWith("browser-nav-state", expect.anything());
    // A page the user is actively reading is never yanked to the agent view.
    expect(agentSurfacedCalls(trustedWC.send)).toEqual([]);
    await flush();
    expect(viewsChangedCount(trustedWC.send)).toBe(1);
  });

  it("does not retarget when the current view is another agent view", async () => {
    h.viewsById.set("agent-a", { webContents: makeWc("") });
    h.viewsById.set("agent-b", { webContents: makeWc("https://agent.example/b") });
    h.handlers.get("browser-switch-view")!({ sender: trustedWC }, "agent-a");
    h.showCalls = 0;
    autoSurfaceAgentView("agent-b");
    expect(currentNavViewId()).toBe("agent-a");
    expect(h.showCalls).toBe(0);
    // Not foreground family → no retarget, no surface push.
    expect(agentSurfacedCalls(trustedWC.send)).toEqual([]);
  });

  it("browser-new-tab mints user-N on the current view's partition and returns nav state", async () => {
    h.attachedId = "foreground";
    h.poolList = [{ viewId: "foreground", partition: "persist:lax-profile-work" }];
    const state = await h.handlers.get("browser-new-tab")!({ sender: trustedWC }, undefined) as {
      viewId: string; url: string;
    };
    const [mintedId, opts] = h.createCalls.at(-1)! as [string, { partition: string; agentDriven: boolean }];
    expect(mintedId).toMatch(/^user-\d+$/);
    expect(opts).toEqual({ partition: "persist:lax-profile-work", agentDriven: false });
    expect(state.viewId).toBe(mintedId);
    expect(state.url).toBe("about:blank");
    expect(currentNavViewId()).toBe(mintedId);
    expect(h.showCalls).toBe(1); // something was attached → the new tab is shown
    expect(h.setBoundsCalls).toEqual([[mintedId, { x: 10, y: 20, width: 300, height: 400 }]]);
  });

  it("browser-new-tab falls back to the default partition, loads the url, and skips attach when detached", async () => {
    h.attachedId = null;
    h.poolList = []; // current view not listed → fallback partition
    const state = await h.handlers.get("browser-new-tab")!({ sender: trustedWC }, "https://example.com/") as {
      viewId: string; url: string;
    };
    const [, opts] = h.createCalls.at(-1)! as [string, { partition: string }];
    expect(opts.partition).toBe("persist:lax-profile-default");
    expect(state.url).toBe("https://example.com/");
    expect(h.showCalls).toBe(0);
  });

  it("browser-new-tab is trusted-sender gated", async () => {
    const before = h.createCalls.length;
    const state = await h.handlers.get("browser-new-tab")!({ sender: {} }, "https://evil.example/");
    expect(state).toBeNull();
    expect(h.createCalls.length).toBe(before);
  });

  it("browser-close-view closes a user view and returns true", async () => {
    h.viewsById.set("user-3", { webContents: makeWc("https://x/") });
    h.poolList = [{ viewId: "user-3", partition: "persist:lax-profile-default", agentDriven: false }];
    const ok = h.handlers.get("browser-close-view")!({ sender: trustedWC }, "user-3");
    expect(ok).toBe(true);
    expect(h.closeCalls).toContain("user-3");
  });

  it("browser-close-view closes an agent view AND pushes the recovery notice to the server child", async () => {
    const { setBrowserUiEventSink } = await import("../desktop/src/browser-perception");
    const pushed: Array<Record<string, unknown>> = [];
    setBrowserUiEventSink((msg) => pushed.push(msg));
    try {
      h.viewsById.set("agent-9", { webContents: makeWc("https://agent/") });
      h.poolList = [{ viewId: "agent-9", partition: "persist:lax-profile-work", agentDriven: true }];
      const ok = h.handlers.get("browser-close-view")!({ sender: trustedWC }, "agent-9");
      expect(ok).toBe(true);
      expect(h.closeCalls).toContain("agent-9");
      expect(pushed).toEqual([
        expect.objectContaining({ type: "lax:browser-agent-view-closed", viewId: "agent-9" }),
      ]);
    } finally {
      setBrowserUiEventSink(null);
    }
  });

  it("browser-close-view does NOT push the agent-view-closed notice for a user view", async () => {
    const { setBrowserUiEventSink } = await import("../desktop/src/browser-perception");
    const pushed: Array<Record<string, unknown>> = [];
    setBrowserUiEventSink((msg) => pushed.push(msg));
    try {
      h.viewsById.set("user-4", { webContents: makeWc("https://x/") });
      h.poolList = [{ viewId: "user-4", partition: "persist:lax-profile-default", agentDriven: false }];
      const ok = h.handlers.get("browser-close-view")!({ sender: trustedWC }, "user-4");
      expect(ok).toBe(true);
      expect(pushed).toEqual([]);
    } finally {
      setBrowserUiEventSink(null);
    }
  });

  it("browser-close-view returns false for an unknown view", async () => {
    h.poolList = [];
    const ok = h.handlers.get("browser-close-view")!({ sender: trustedWC }, "ghost");
    expect(ok).toBe(false);
    expect(h.closeCalls).toEqual([]);
  });

  it("closing the CURRENT attached view falls back to foreground and shows it", async () => {
    // Make user-4 the current + attached view.
    h.viewsById.set("user-4", { webContents: makeWc("https://x/") });
    h.handlers.get("browser-switch-view")!({ sender: trustedWC }, "user-4");
    h.attachedId = "user-4";
    h.showCalls = 0;
    h.setBoundsCalls = [];
    h.poolList = [{ viewId: "user-4", partition: "persist:lax-profile-default", agentDriven: false }];
    const ok = h.handlers.get("browser-close-view")!({ sender: trustedWC }, "user-4");
    expect(ok).toBe(true);
    expect(h.closeCalls).toContain("user-4");
    // Anchor fell back to foreground and re-attached it (not left on a dead view).
    expect(currentNavViewId()).toBe("foreground");
    expect(h.showCalls).toBe(1);
  });

  it("browser-close-view is trusted-sender gated", () => {
    h.poolList = [{ viewId: "user-3", partition: "persist:lax-profile-default", agentDriven: false }];
    const ok = h.handlers.get("browser-close-view")!({ sender: {} }, "user-3");
    expect(ok).toBe(false);
    expect(h.closeCalls).not.toContain("user-3");
  });

  it("setupBrowserIPC wires the pool listener; bursts debounce into ONE views-changed", async () => {
    expect(h.poolListener).toBeTypeOf("function");
    h.poolListener!();
    h.poolListener!();
    h.poolListener!();
    await flush();
    expect(viewsChangedCount(trustedWC.send)).toBe(1);
  });
});

describe("server bridge auto-surface hook + close guard (server-bridge-browser.ts)", () => {
  let proc: { send: Mock; connected: boolean; killed: boolean };
  let trustedWC: { getZoomFactor(): number; send: Mock };

  beforeEach(() => {
    trustedWC = { getZoomFactor: () => 1, send: vi.fn() };
    h.mainWin = { isDestroyed: () => false, webContents: trustedWC };
    h.viewsById.clear();
    h.poolList = [];
    h.closeCalls = [];
    proc = { send: vi.fn(() => true), connected: true, killed: false };
    (autoSurfaceAgentView as unknown as Mock).mockClear();
  });

  async function driveNavigate(viewId: string) {
    const listeners = new Map<string, (...a: unknown[]) => void>();
    const wc = makeWc("");
    (wc as { on: unknown }).on = (ev: string, fn: (...a: unknown[]) => void) => { listeners.set(ev, fn); };
    wc.getURL = () => "https://agent.example/done";
    h.viewsById.set(viewId, { webContents: wc });
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-navigate", id: 7, viewId, url: "https://agent.example/" },
    );
    // Real Electron ordering: loadURL fires did-start-loading before any
    // finish event — navigate-settle gates success on it (stale-event guard).
    listeners.get("did-start-loading")!();
    listeners.get("did-finish-load")!();
    await flush();
  }

  it("a successful navigate on an agentDriven view calls autoSurfaceAgentView", async () => {
    h.poolList = [{ viewId: "agent-1", agentDriven: true }];
    await driveNavigate("agent-1");
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lax:browser-navigate-result", id: 7, ok: true }),
    );
    expect(autoSurfaceAgentView).toHaveBeenCalledWith("agent-1");
  });

  it("a successful navigate on a NON-agent view never auto-surfaces", async () => {
    h.poolList = [{ viewId: "user-9", agentDriven: false }];
    await driveNavigate("user-9");
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lax:browser-navigate-result", id: 7, ok: true }),
    );
    expect(autoSurfaceAgentView).not.toHaveBeenCalled();
  });

  it("capture falls back to CDP when a detached view's capturePage comes back empty", async () => {
    // A backgrounded (removeChildView'd) view has no compositor surface —
    // capturePage() returns an empty image (2026-07-20 "no image data").
    const wc = makeWc("");
    (wc as { capturePage?: unknown }).capturePage = async () => ({ toPNG: () => Buffer.alloc(0) });
    const dbg = {
      attached: false,
      isAttached: () => dbg.attached,
      attach: vi.fn(() => { dbg.attached = true; }),
      detach: vi.fn(() => { dbg.attached = false; }),
      sendCommand: vi.fn(async () => ({ data: "Zm9vYmFy" })),
    };
    (wc as { debugger?: unknown }).debugger = dbg;
    h.viewsById.set("agent-cap", { webContents: wc });
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-capture", id: 9, viewId: "agent-cap" } as never,
    );
    await flush();
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lax:browser-capture-result", id: 9, ok: true, pngB64: "Zm9vYmFy" }),
    );
    expect(dbg.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    expect(dbg.attach).toHaveBeenCalled();
    expect(dbg.detach).toHaveBeenCalled();
  });

  it("capture with a live compositor surface never touches the debugger", async () => {
    const wc = makeWc("");
    (wc as { capturePage?: unknown }).capturePage = async () => ({ toPNG: () => Buffer.from("real-png") });
    const dbg = { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() };
    (wc as { debugger?: unknown }).debugger = dbg;
    h.viewsById.set("agent-cap2", { webContents: wc });
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-capture", id: 10, viewId: "agent-cap2" } as never,
    );
    await flush();
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lax:browser-capture-result",
        id: 10,
        ok: true,
        pngB64: Buffer.from("real-png").toString("base64"),
      }),
    );
    expect(dbg.attach).not.toHaveBeenCalled();
  });

  it("lifecycle close REFUSES non-agentDriven views (ok:false reply, view untouched)", async () => {
    h.poolList = [{ viewId: "foreground", agentDriven: false }];
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-lifecycle", id: 3, op: "close", viewId: "foreground" },
    );
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-lifecycle-result",
      id: 3,
      ok: false,
      error: expect.stringContaining("refusing to close non-agent view"),
    }));
    expect(h.closeCalls).toEqual([]);
  });

  it("lifecycle close still closes agentDriven views", async () => {
    h.poolList = [{ viewId: "agent-9", agentDriven: true }];
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-lifecycle", id: 4, op: "close", viewId: "agent-9" },
    );
    await flush();
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lax:browser-lifecycle-result", id: 4, ok: true }),
    );
    expect(h.closeCalls).toEqual(["agent-9"]);
  });
});

describe("browser-views pool seams (real module)", () => {
  beforeEach(() => {
    h.mainWin = {
      isDestroyed: () => false,
      webContents: { send: () => {} },
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    } as never;
  });

  it("fires the pool-change listener on create/show-flip/close and tracks the attached id", () => {
    let fired = 0;
    realViews.setPoolChangedListener(() => { fired++; });
    try {
      expect(realViews.getAttachedViewId()).toBeNull();
      realViews.createBrowserView("pv-1", { partition: "persist:lax-profile-default" });
      expect(fired).toBe(1);
      realViews.showBrowserView("pv-1");
      expect(realViews.getAttachedViewId()).toBe("pv-1");
      expect(fired).toBe(2);
      realViews.showBrowserView("pv-1"); // already attached — no flip, no fire
      expect(fired).toBe(2);
      realViews.closeBrowserView("pv-1");
      expect(fired).toBe(3);
      expect(realViews.getAttachedViewId()).toBeNull();
    } finally {
      realViews.setPoolChangedListener(null);
    }
  });

  it("registers user/agent view trust for the loopback carve-out and cleans up on close", () => {
    // browser-views registers the resolver with the partition layer at import;
    // the mocked setViewTrustResolver captured it in h.trustResolver.
    expect(h.trustResolver).toBeTypeOf("function");
    realViews.createBrowserView("pv-user", { partition: "persist:lax-profile-default" });
    realViews.createBrowserView("pv-agent", { partition: "persist:lax-profile-default", agentDriven: true });
    try {
      const userId = realViews.getBrowserView("pv-user")!.webContents.id;
      const agentId = realViews.getBrowserView("pv-agent")!.webContents.id;
      expect(h.trustResolver!(userId)).toBe("user");
      expect(h.trustResolver!(agentId)).toBe("agent");
      expect(h.trustResolver!(999999)).toBeNull();
      realViews.closeBrowserView("pv-user");
      expect(h.trustResolver!(userId)).toBeNull();
    } finally {
      if (realViews.getBrowserView("pv-user")) realViews.closeBrowserView("pv-user");
      if (realViews.getBrowserView("pv-agent")) realViews.closeBrowserView("pv-agent");
    }
  });

  it("attach flips between two views fire the listener and re-point getAttachedViewId", () => {
    realViews.createBrowserView("pv-a", { partition: "persist:lax-profile-default" });
    realViews.createBrowserView("pv-b", { partition: "persist:lax-profile-default" });
    let fired = 0;
    realViews.setPoolChangedListener(() => { fired++; });
    try {
      realViews.showBrowserView("pv-a");
      expect(realViews.getAttachedViewId()).toBe("pv-a");
      realViews.showBrowserView("pv-b");
      expect(realViews.getAttachedViewId()).toBe("pv-b");
      expect(fired).toBe(2);
    } finally {
      realViews.setPoolChangedListener(null);
      realViews.closeBrowserView("pv-a");
      realViews.closeBrowserView("pv-b");
    }
  });

  it("stacks the chat overlay above the Browser and removes only that overlay", () => {
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    h.mainWin = {
      isDestroyed: () => false,
      webContents: { send: () => {} },
      contentView: { addChildView, removeChildView },
    } as never;
    realViews.createBrowserView("pv-overlay", { partition: "persist:lax-profile-default" });
    try {
      realViews.showBrowserView("pv-overlay");
      realViews.setBrowserChatOverlay(
        { x: 500, y: 600, width: 840, height: 380 },
        { sessionId: "chat-1", collapsed: false, latestOpen: true },
        "http://127.0.0.1:7007/?token=test&browserChatOverlay=1#chat",
      );
      expect(addChildView).toHaveBeenCalledTimes(2);
      expect(addChildView.mock.calls[1][0]).not.toBe(addChildView.mock.calls[0][0]);

      realViews.setBrowserChatOverlay(null, null, null);
      expect(removeChildView).toHaveBeenCalledWith(addChildView.mock.calls[1][0]);
    } finally {
      realViews.closeBrowserView("pv-overlay");
    }
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
