// @vitest-environment happy-dom
// Browser error card (browser-error-card.js) — drives the real module sources
// (error card + browser-tab.js, same load order as app.html) against a fake
// desktop bridge and a fake apiFetch, mirroring the browser-library-panel
// harness. Covers: the ERR_BLOCKED_BY_CLIENT (-20) deny-reason lookup and its
// rendering, the non-blocked path making NO lookup, silent fetch-failure
// fallback, and Retry re-navigating to the failed URL instead of reload().
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
let apiCalls: string[];
let denyResponse: unknown;
let apiFail: boolean;

function flush() { return new Promise<void>((r) => setTimeout(r, 0)); }

function failNav(code: number, description: string, url: string) {
  navStateCb!({
    url, title: "", canGoBack: false, canGoForward: false, loading: false,
    viewId: "foreground",
    loadError: { code, description, url },
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="agent-feeds">
      <div id="browser-tab-body">
        <div id="browser-address-bar">
          <button id="browser-nav-back" disabled></button>
          <button id="browser-nav-fwd" disabled></button>
          <button id="browser-nav-reload"></button>
          <input id="browser-url-input" type="text">
        </div>
        <div id="browser-view-anchor"></div>
      </div>
    </div>`;

  navStateCb = null;
  apiCalls = [];
  denyResponse = {};
  apiFail = false;
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

  // The card resolves `apiFetch` off the global scope (shared-api.js in prod).
  (globalThis as unknown as { apiFetch: unknown }).apiFetch = (path: string) => {
    apiCalls.push(path);
    if (apiFail) return Promise.reject(new Error("server down"));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(denyResponse) });
  };

  // Same load order as app.html: error card first, then the tab module.
  const cardSrc = readFileSync(join(here, "../public/js/browser-error-card.js"), "utf8");
  new Function(cardSrc)();
  const tabSrc = readFileSync(join(here, "../public/js/browser-tab.js"), "utf8");
  new Function(tabSrc)();
});

describe("browser error card deny-reason rendering", () => {
  it("a -20 (ERR_BLOCKED_BY_CLIENT) failure fetches the deny reason and renders reason + recovery", async () => {
    denyResponse = { reason: "host is not on the egress allowlist", recovery: "Add it under Settings → Browser egress." };
    failNav(-20, "ERR_BLOCKED_BY_CLIENT", "https://blocked.example/page");
    await flush();

    expect(apiCalls).toEqual([
      "/api/browser/deny-reason?url=" + encodeURIComponent("https://blocked.example/page") + "&viewId=foreground",
    ]);
    const anchor = document.getElementById("browser-view-anchor")!;
    expect(anchor.textContent).toContain("Can't reach this page");
    expect(anchor.textContent).toContain("host is not on the egress allowlist");
    expect(anchor.textContent).toContain("Add it under Settings → Browser egress.");
    // The bare Chromium string is replaced; the URL stays visible.
    expect(anchor.textContent).not.toContain("ERR_BLOCKED_BY_CLIENT");
    expect(anchor.textContent).toContain("https://blocked.example/page");
  });

  it("Retry re-navigates to the failed URL — it does NOT reload()", async () => {
    denyResponse = { reason: "policy deny" };
    failNav(-20, "ERR_BLOCKED_BY_CLIENT", "https://blocked.example/page");
    await flush();

    document.getElementById("browser-load-error-retry")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.navigate).toHaveBeenCalledWith("https://blocked.example/page");
    expect(bridge.reload).not.toHaveBeenCalled();
  });

  it("a non-blocked failure (-102) never queries the deny route and keeps the Chromium string", async () => {
    failNav(-102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:8188/");
    await flush();

    expect(apiCalls).toEqual([]);
    const anchor = document.getElementById("browser-view-anchor")!;
    expect(anchor.textContent).toContain("ERR_CONNECTION_REFUSED");
    expect(anchor.textContent).toContain("(-102)");
  });

  it("an empty {} deny response keeps the basic error text", async () => {
    denyResponse = {};
    failNav(-20, "ERR_BLOCKED_BY_CLIENT", "https://unknown.example/");
    await flush();

    expect(apiCalls).toHaveLength(1);
    const anchor = document.getElementById("browser-view-anchor")!;
    expect(anchor.textContent).toContain("ERR_BLOCKED_BY_CLIENT");
    expect(anchor.textContent).toContain("(-20)");
  });

  it("a failed deny-reason fetch is silent — the basic card still renders and Retry works", async () => {
    apiFail = true;
    failNav(-20, "ERR_BLOCKED_BY_CLIENT", "https://blocked.example/x");
    await flush();

    const anchor = document.getElementById("browser-view-anchor")!;
    expect(anchor.textContent).toContain("Can't reach this page");
    expect(anchor.textContent).toContain("ERR_BLOCKED_BY_CLIENT");
    document.getElementById("browser-load-error-retry")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bridge.navigate).toHaveBeenCalledWith("https://blocked.example/x");
  });

  it("a late deny response for a CLEARED card never touches the DOM", async () => {
    // Hold the deny fetch open until after the error clears.
    type FakeResponse = { ok: boolean; json: () => Promise<unknown> };
    let release: ((v: FakeResponse) => void) | undefined;
    (globalThis as unknown as { apiFetch: unknown }).apiFetch = (path: string) => {
      apiCalls.push(path);
      return new Promise<FakeResponse>((r) => { release = r; });
    };
    failNav(-20, "ERR_BLOCKED_BY_CLIENT", "https://blocked.example/late");
    // Load recovers before the reason arrives → card cleared.
    navStateCb!({
      url: "https://blocked.example/late", title: "", canGoBack: false, canGoForward: false,
      loading: true, viewId: "foreground", loadError: null,
    });
    expect(document.getElementById("browser-view-anchor")!.textContent).toBe("");
    release!({ ok: true, json: () => Promise.resolve({ reason: "too late" }) });
    await flush();
    expect(document.getElementById("browser-view-anchor")!.textContent).toBe("");
  });
});

declare global {
  interface Window {
    laxBrowserErrorCard: { render(loadError: unknown, opts: unknown): void };
  }
}
