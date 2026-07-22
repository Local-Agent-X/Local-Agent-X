// @vitest-environment happy-dom
// Find-in-page + per-view zoom for the Browser pane (find-zoom chunk).
//
// Renderer half: public/js/browser-find.js — the find bar (a normal-flow row
// between toolbar and anchor), the Ctrl+F/Esc hotkeys, and the session-scoped
// per-view zoom map reapplied on view switch. Driven as the real IIFE source
// against a fake desktop bridge, mirroring browser-tab.test.ts.
//
// Main half: desktop/src/browser-page-controls.ts — the trusted-sender-gated
// command surface (browser-find-*/browser-*-zoom), the tagged
// "browser-found-in-page" push, and the per-view before-input-event handler
// that scopes Ctrl+±/Ctrl+F/Esc to focus-inside-the-page. Includes the
// bounds-math regression: view zoom must never feed scaleRectToDip's
// WINDOW-zoom DIP conversion.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainWin: null as null | { isDestroyed(): boolean; webContents: unknown },
  fakeView: null as unknown,
  viewsById: new Map<string, unknown>(),
  setBoundsCalls: [] as unknown[][],
  poolListener: null as null | (() => void),
  poolList: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
}));
vi.mock("../desktop/src/window", () => ({ getMainWindow: () => h.mainWin }));
vi.mock("../desktop/src/browser-views", () => ({
  createBrowserView: () => {},
  closeBrowserView: () => {},
  getBrowserView: (viewId: string) => (h.viewsById.has(viewId) ? h.viewsById.get(viewId) : h.fakeView),
  getAttachedViewId: () => null,
  setPoolChangedListener: (fn: (() => void) | null) => { h.poolListener = fn; },
  listBrowserViews: () => h.poolList,
  hideBrowserView: () => {},
  setBrowserChatOverlay: () => {},
  setBrowserViewBounds: (...args: unknown[]) => { h.setBoundsCalls.push(args); },
  showBrowserView: () => {},
}));

import { setupBrowserIPC } from "../desktop/src/browser-ipc";

const here = dirname(fileURLToPath(import.meta.url));
const FIND_SRC = readFileSync(join(here, "../public/js/browser-find.js"), "utf8");
const TAB_SRC = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");

// ─────────────────────────────── renderer half ───────────────────────────────

interface FakeBridge {
  setBounds: Mock; setVisible: Mock; navigate: Mock; goBack: Mock; goForward: Mock;
  reload: Mock; getNavState: Mock; onNavState: Mock;
  switchView: Mock;
  findStart: Mock; findNext: Mock; findPrev: Mock; findStop: Mock;
  onFoundInPage: Mock; onFindHotkey: Mock; onFindClosed: Mock;
  setZoom: Mock; getZoom: Mock; onZoomChanged: Mock;
}

let bridge: FakeBridge;
let foundCb: ((r: unknown) => void) | null;
let hotkeyCb: ((info: unknown) => void) | null;
let closedCb: ((info: unknown) => void) | null;
let zoomCb: ((info: unknown) => void) | null;

function setDom(): void {
  document.body.innerHTML = `
    <div id="agent-feeds">
      <div id="browser-tab-body">
        <div id="browser-address-bar">
          <button id="browser-nav-back"></button>
          <button id="browser-nav-fwd"></button>
          <button id="browser-nav-reload"></button>
          <input id="browser-url-input">
          <button id="browser-zoom-out"></button>
          <button id="browser-zoom-reset">100%</button>
          <button id="browser-zoom-in"></button>
          <div id="browser-view-switcher-slot"></div>
        </div>
        <div id="browser-view-anchor"></div>
      </div>
    </div>`;
}

function makeBridge(): FakeBridge {
  return {
    setBounds: vi.fn(), setVisible: vi.fn(), navigate: vi.fn(), goBack: vi.fn(),
    goForward: vi.fn(), reload: vi.fn(),
    getNavState: vi.fn().mockResolvedValue(null),
    onNavState: vi.fn(),
    switchView: vi.fn((viewId: string) => Promise.resolve({
      viewId, url: "https://x/", title: "X", canGoBack: false, canGoForward: false, loading: false,
    })),
    findStart: vi.fn(), findNext: vi.fn(), findPrev: vi.fn(), findStop: vi.fn(),
    onFoundInPage: vi.fn((cb: (r: unknown) => void) => { foundCb = cb; }),
    onFindHotkey: vi.fn((cb: (info: unknown) => void) => { hotkeyCb = cb; }),
    onFindClosed: vi.fn((cb: (info: unknown) => void) => { closedCb = cb; }),
    setZoom: vi.fn(), getZoom: vi.fn().mockResolvedValue(null),
    onZoomChanged: vi.fn((cb: (info: unknown) => void) => { zoomCb = cb; }),
  };
}

function loadRenderer(withDesktop = true): void {
  if (withDesktop) {
    (window as unknown as { desktop: unknown }).desktop = { isDesktop: true, browser: bridge };
  } else {
    delete (window as unknown as { desktop?: unknown }).desktop;
  }
  // Same order as app.html: find module before the tab module.
  new Function(FIND_SRC)();
  new Function(TAB_SRC)();
}

function findBar(): HTMLElement | null { return document.getElementById("browser-find-bar"); }
function findInput(): HTMLInputElement { return document.getElementById("browser-find-input") as HTMLInputElement; }
function pressCtrlF(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
}

const flushMicrotasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Typed handles onto the IIFE globals (cast, not `declare global` — the Window
// interface is already augmented by browser-tab.test.ts with a different shape).
const g = globalThis as unknown as {
  laxBrowserTab: { onTabShown(): void; onTabHidden(): void; switchTo(viewId: string): void };
  laxBrowserFind: {
    open(): void; close(): void; zoomStep(dir: string): void;
    onViewSelected(viewId: string): void; onPaneHidden(): void;
  };
};

describe("browser-find.js (renderer find bar + zoom map)", () => {
  beforeEach(() => {
    setDom();
    foundCb = hotkeyCb = closedCb = zoomCb = null;
    bridge = makeBridge();
    loadRenderer();
  });

  it("Ctrl+F opens the bar while the pane is visible; typing finds; Esc closes and stops", () => {
    pressCtrlF();
    const bar = findBar()!;
    expect(bar).not.toBeNull();
    expect(bar.style.display).toBe("");
    // The bar is a FLOW row before the anchor — never overlaying it (the
    // native view paints above the DOM; an overlay would also trip the
    // occlusion probe and blank the page).
    expect(bar.nextElementSibling).toBe(document.getElementById("browser-view-anchor"));

    findInput().value = "needle";
    findInput().dispatchEvent(new Event("input", { bubbles: true }));
    expect(bridge.findStart).toHaveBeenCalledWith("needle");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bar.style.display).toBe("none");
    expect(bridge.findStop).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+F does nothing while the pane is hidden or the panel collapsed", () => {
    document.getElementById("browser-tab-body")!.style.display = "none";
    pressCtrlF();
    expect(findBar()).toBeNull();

    document.getElementById("browser-tab-body")!.style.display = "";
    document.getElementById("agent-feeds")!.classList.add("collapsed");
    pressCtrlF();
    expect(findBar()).toBeNull();
  });

  it("Enter/Shift+Enter and the arrow buttons step with the right direction", () => {
    pressCtrlF();
    findInput().value = "needle";
    findInput().dispatchEvent(new Event("input", { bubbles: true }));

    findInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(bridge.findNext).toHaveBeenLastCalledWith("needle");
    findInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(bridge.findPrev).toHaveBeenLastCalledWith("needle");

    document.getElementById("browser-find-next")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.findNext).toHaveBeenCalledTimes(2);
    document.getElementById("browser-find-prev")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.findPrev).toHaveBeenCalledTimes(2);
  });

  it("match count renders from a tagged found-in-page push; other views' results are ignored", () => {
    g.laxBrowserFind.onViewSelected("foreground");
    pressCtrlF();
    foundCb!({ viewId: "foreground", matches: 17, activeMatchOrdinal: 2, finalUpdate: true });
    expect(document.getElementById("browser-find-count")!.textContent).toBe("2/17");
    foundCb!({ viewId: "agent-9", matches: 1, activeMatchOrdinal: 1, finalUpdate: true });
    expect(document.getElementById("browser-find-count")!.textContent).toBe("2/17");
    foundCb!({ viewId: "foreground", matches: 0, activeMatchOrdinal: 0, finalUpdate: true });
    expect(document.getElementById("browser-find-count")!.textContent).toBe("0/0");
  });

  it("main's in-page hotkey pushes open/close the bar (Esc inside the page already stopped the find)", () => {
    hotkeyCb!({ viewId: "foreground" });
    expect(findBar()!.style.display).toBe("");
    closedCb!({ viewId: "foreground" });
    expect(findBar()!.style.display).toBe("none");
    // Main already stopped the find — the renderer must NOT double-stop.
    expect(bridge.findStop).not.toHaveBeenCalled();
  });

  it("hiding the pane closes the bar and stops the find", () => {
    pressCtrlF();
    expect(findBar()!.style.display).toBe("");
    g.laxBrowserTab.onTabHidden();
    expect(findBar()!.style.display).toBe("none");
    expect(bridge.findStop).toHaveBeenCalledTimes(1);
  });

  it("toolbar zoom steps call setZoom and the % label tracks the echoed factor", () => {
    g.laxBrowserFind.onViewSelected("foreground");
    expect(bridge.setZoom).toHaveBeenLastCalledWith(1); // selection seeds default
    g.laxBrowserFind.zoomStep("in");
    expect(bridge.setZoom).toHaveBeenLastCalledWith(1.1);
    expect(document.getElementById("browser-zoom-reset")!.textContent).toBe("110%");
    g.laxBrowserFind.zoomStep("reset");
    expect(bridge.setZoom).toHaveBeenLastCalledWith(1);
    expect(document.getElementById("browser-zoom-reset")!.textContent).toBe("100%");
    // Zoom applied MAIN-side (in-page Ctrl+=) echoes back into the map/label.
    zoomCb!({ viewId: "foreground", factor: 1.3 });
    expect(document.getElementById("browser-zoom-reset")!.textContent).toBe("130%");
  });

  it("switching views reapplies each view's stored zoom factor", async () => {
    g.laxBrowserFind.onViewSelected("foreground");
    zoomCb!({ viewId: "foreground", factor: 1.3 }); // user zoomed the foreground page
    bridge.setZoom.mockClear();

    g.laxBrowserTab.switchTo("user-1");
    await flushMicrotasks();
    expect(bridge.setZoom).toHaveBeenLastCalledWith(1); // fresh view → default

    g.laxBrowserTab.switchTo("foreground");
    await flushMicrotasks();
    expect(bridge.setZoom).toHaveBeenLastCalledWith(1.3); // stored factor returns
  });

  it("a plain browser (no window.desktop) neither crashes nor registers the hotkey", () => {
    setDom();
    bridge = makeBridge();
    expect(() => loadRenderer(false)).not.toThrow();
    pressCtrlF();
    expect(findBar()).toBeNull();
    expect(() => g.laxBrowserFind.zoomStep("in")).not.toThrow();
    expect(() => g.laxBrowserFind.onViewSelected("foreground")).not.toThrow();
  });
});

// ────────────────────────────── main-process half ─────────────────────────────

interface FakeViewWC {
  isDestroyed(): boolean; isLoading(): boolean; getURL(): string; getTitle(): string;
  loadURL: Mock; reload: Mock; stop: Mock; on: Mock;
  findInPage: Mock; stopFindInPage: Mock; setZoomFactor: Mock; getZoomFactor: Mock;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
}

function makeViewWc(): FakeViewWC {
  return {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => "https://private.example/page",
    getTitle: () => "Private",
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    setZoomFactor: vi.fn(),
    getZoomFactor: vi.fn(() => 1),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
}

function wcHandler(wc: FakeViewWC, event: string): ((...a: unknown[]) => void) | undefined {
  return wc.on.mock.calls.filter((c) => c[0] === event).map((c) => c[1] as (...a: unknown[]) => void)[0];
}

describe("browser-page-controls.ts (main-process find/zoom surface)", () => {
  let zoom: number;
  let trustedWC: { getZoomFactor(): number; setZoomFactor: Mock; focus: Mock; send: Mock };
  let viewWC: FakeViewWC;

  beforeEach(() => {
    zoom = 1;
    trustedWC = { getZoomFactor: () => zoom, setZoomFactor: vi.fn(), focus: vi.fn(), send: vi.fn() };
    h.mainWin = { isDestroyed: () => false, webContents: trustedWC };
    viewWC = makeViewWc();
    h.fakeView = { webContents: viewWC };
    h.viewsById.clear();
    h.poolList = [];
    h.setBoundsCalls = [];
    h.handlers.clear();
    setupBrowserIPC();
  });

  function zoomChangedPushes(): unknown[] {
    return trustedWC.send.mock.calls.filter((c) => c[0] === "browser-zoom-changed").map((c) => c[1]);
  }

  it("find-start finds on the selected view; next/prev continue with direction; stop clears", () => {
    h.handlers.get("browser-find-start")!({ sender: trustedWC }, "needle");
    expect(viewWC.findInPage).toHaveBeenLastCalledWith("needle", undefined);
    h.handlers.get("browser-find-next")!({ sender: trustedWC }, "needle");
    expect(viewWC.findInPage).toHaveBeenLastCalledWith("needle", { forward: true, findNext: true });
    h.handlers.get("browser-find-prev")!({ sender: trustedWC }, "needle");
    expect(viewWC.findInPage).toHaveBeenLastCalledWith("needle", { forward: false, findNext: true });
    h.handlers.get("browser-find-stop")!({ sender: trustedWC });
    expect(viewWC.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("found-in-page results are pushed to the renderer tagged with the viewId", () => {
    h.handlers.get("browser-find-start")!({ sender: trustedWC }, "needle");
    const onFound = wcHandler(viewWC, "found-in-page")!;
    expect(onFound).toBeTypeOf("function");
    onFound({}, { requestId: 1, matches: 5, activeMatchOrdinal: 2, finalUpdate: true, selectionArea: {} });
    expect(trustedWC.send).toHaveBeenCalledWith("browser-found-in-page", {
      viewId: "foreground", matches: 5, activeMatchOrdinal: 2, finalUpdate: true,
    });
  });

  it("in-page Ctrl+= / Ctrl+- / Ctrl+0 zoom the VIEW's webContents, never the window's", () => {
    h.handlers.get("browser-find-start")!({ sender: trustedWC }, "wire"); // wires the view
    const onInput = wcHandler(viewWC, "before-input-event")!;
    expect(onInput).toBeTypeOf("function");

    const ev = () => ({ preventDefault: vi.fn() });
    let e = ev();
    onInput(e, { type: "keyDown", control: true, meta: false, key: "=" });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(viewWC.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    e = ev();
    onInput(e, { type: "keyDown", control: true, meta: false, key: "-" });
    expect(viewWC.setZoomFactor).toHaveBeenLastCalledWith(0.9);
    e = ev();
    onInput(e, { type: "keyDown", control: true, meta: false, key: "0" });
    expect(viewWC.setZoomFactor).toHaveBeenLastCalledWith(1);
    // The WINDOW's zoom is untouched — window.ts keeps sole ownership of it.
    expect(trustedWC.setZoomFactor).not.toHaveBeenCalled();
    // Every applied factor is echoed so the renderer's session map stays true.
    expect(zoomChangedPushes()).toEqual([
      { viewId: "foreground", factor: 1.1 },
      { viewId: "foreground", factor: 0.9 },
      { viewId: "foreground", factor: 1 },
    ]);
  });

  it("in-page Ctrl+F focuses the renderer and pushes the hotkey; Esc intercepts ONLY during a find", () => {
    h.handlers.get("browser-find-start")!({ sender: trustedWC }, "wire");
    h.handlers.get("browser-find-stop")!({ sender: trustedWC }); // no active find
    const onInput = wcHandler(viewWC, "before-input-event")!;

    // Esc with NO active find: the page keeps its own Esc key.
    let e = { preventDefault: vi.fn() };
    onInput(e, { type: "keyDown", control: false, meta: false, key: "Escape" });
    expect(e.preventDefault).not.toHaveBeenCalled();

    e = { preventDefault: vi.fn() };
    onInput(e, { type: "keyDown", control: true, meta: false, key: "f" });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(trustedWC.focus).toHaveBeenCalled();
    expect(trustedWC.send).toHaveBeenCalledWith("browser-find-hotkey", { viewId: "foreground" });

    // Active find → Esc stops it (clearSelection) and tells the renderer.
    h.handlers.get("browser-find-start")!({ sender: trustedWC }, "needle");
    viewWC.stopFindInPage.mockClear();
    e = { preventDefault: vi.fn() };
    onInput(e, { type: "keyDown", control: false, meta: false, key: "Escape" });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(viewWC.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(trustedWC.send).toHaveBeenCalledWith("browser-find-closed", { viewId: "foreground" });
  });

  it("browser-set-zoom clamps to the view range and echoes; browser-get-zoom reads the view", () => {
    h.handlers.get("browser-set-zoom")!({ sender: trustedWC }, 9);
    expect(viewWC.setZoomFactor).toHaveBeenLastCalledWith(3);
    h.handlers.get("browser-set-zoom")!({ sender: trustedWC }, 0.05);
    expect(viewWC.setZoomFactor).toHaveBeenLastCalledWith(0.25);
    h.handlers.get("browser-set-zoom")!({ sender: trustedWC }, Number.NaN);
    expect(viewWC.setZoomFactor).toHaveBeenCalledTimes(2);
    expect(zoomChangedPushes()).toEqual([
      { viewId: "foreground", factor: 3 },
      { viewId: "foreground", factor: 0.25 },
    ]);
    expect(h.handlers.get("browser-get-zoom")!({ sender: trustedWC })).toEqual({ viewId: "foreground", factor: 1 });
  });

  it("REGRESSION: view zoom never feeds the setBounds DIP conversion — that stays keyed to WINDOW zoom", () => {
    zoom = 1.25; // window content zoom
    h.handlers.get("browser-set-zoom")!({ sender: trustedWC }, 2); // view zoomed to 200%
    viewWC.getZoomFactor.mockReturnValue(2);
    h.handlers.get("browser-set-bounds")!({ sender: trustedWC }, { x: 100, y: 40, width: 400, height: 600 });
    // ×1.25 (window), NOT ×2 (view): the anchor rect is CSS px of the WINDOW's
    // renderer, so only the window zoom factor converts it to DIPs.
    expect(h.setBoundsCalls).toEqual([["foreground", { x: 125, y: 50, width: 500, height: 750 }]]);
  });

  it("the pool-change sweep wires page controls for every pool view (incl. agent views)", () => {
    const agentWc = makeViewWc();
    h.viewsById.set("agent-7", { webContents: agentWc });
    h.poolList = [{ viewId: "agent-7", partition: "persist:lax-profile-work", agentDriven: true }];
    expect(h.poolListener).toBeTypeOf("function");
    h.poolListener!();
    expect(wcHandler(agentWc, "found-in-page")).toBeTypeOf("function");
    expect(wcHandler(agentWc, "before-input-event")).toBeTypeOf("function");
    // Re-sweeping never double-wires the same webContents.
    const wiredCalls = agentWc.on.mock.calls.length;
    h.poolListener!();
    expect(agentWc.on.mock.calls.length).toBe(wiredCalls);
  });

  it("every find/zoom channel is trusted-sender gated", () => {
    const appWindowWC = {};
    h.handlers.get("browser-find-start")!({ sender: appWindowWC }, "secret");
    h.handlers.get("browser-find-next")!({ sender: appWindowWC }, "secret");
    h.handlers.get("browser-find-prev")!({ sender: appWindowWC }, "secret");
    expect(viewWC.findInPage).not.toHaveBeenCalled();
    h.handlers.get("browser-find-stop")!({ sender: appWindowWC });
    expect(viewWC.stopFindInPage).not.toHaveBeenCalled();
    h.handlers.get("browser-set-zoom")!({ sender: appWindowWC }, 2);
    expect(viewWC.setZoomFactor).not.toHaveBeenCalled();
    expect(h.handlers.get("browser-get-zoom")!({ sender: appWindowWC })).toBeNull();
  });
});
