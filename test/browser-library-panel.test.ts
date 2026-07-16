// @vitest-environment happy-dom
// Library panel (bookmarks + history overlay) — drives the real module source
// (public/js/browser-library.js) against a fake apiFetch, mirroring the
// browser-tab.test.ts harness. Covers: open/close occlusion pokes, rendering
// both sections from the API, bookmark-current-page POST, double-confirmed
// history clear, and the address-bar <datalist> suggestions.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeApi {
  calls: Array<{ path: string; method: string; body?: string }>;
  bookmarks: unknown[];
  history: unknown[];
}

let apiState: FakeApi;
let syncSpy: Mock;

function flush() { return new Promise<void>((r) => setTimeout(r, 0)); }

beforeEach(() => {
  document.body.innerHTML = `
    <div id="browser-tab-body">
      <div id="browser-address-bar">
        <input id="browser-url-input" type="text" list="browser-url-suggestions">
        <datalist id="browser-url-suggestions"></datalist>
        <button id="side-tab-browser"></button>
      </div>
      <div id="browser-library-panel" style="display:none"></div>
    </div>`;

  apiState = { calls: [], bookmarks: [], history: [] };
  syncSpy = vi.fn();
  (window as unknown as { laxBrowserTab: unknown }).laxBrowserTab = { sync: syncSpy, navigateFromInput: vi.fn() };

  // The module resolves `apiFetch` off the global scope (shared-api.js in prod).
  (globalThis as unknown as { apiFetch: unknown }).apiFetch = (path: string, opts?: { method?: string; body?: string }) => {
    apiState.calls.push({ path, method: (opts && opts.method) || "GET", body: opts?.body });
    const data = path.startsWith("/api/browser/bookmarks") && (!opts || !opts.method || opts.method === "GET")
      ? apiState.bookmarks
      : path.startsWith("/api/browser/history") && (!opts || !opts.method || opts.method === "GET")
        ? apiState.history
        : { ok: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  };

  const src = readFileSync(join(here, "../public/js/browser-library.js"), "utf8");
  new Function(src)();
});

describe("browser library panel", () => {
  it("open() shows the panel, pokes the occlusion probe, and renders both sections", async () => {
    apiState.bookmarks = [{ id: "bm-1", url: "https://ex.com/docs", title: "Docs", addedBy: "agent", ts: Date.now() }];
    apiState.history = [{ id: "hist-1", url: "https://ex.com/story", title: "Story", profileId: "default", ts: Date.now() }];
    window.laxBrowserLibrary.open();
    await flush();
    const panel = document.getElementById("browser-library-panel")!;
    expect(panel.style.display).toBe("block");
    expect(syncSpy).toHaveBeenCalled();
    expect(window.laxBrowserLibrary.isOpen()).toBe(true);
    expect(panel.textContent).toContain("Docs");
    expect(panel.textContent).toContain("Story");
    expect(document.getElementById("browser-library-bookmarks")).not.toBeNull();
    expect(document.getElementById("browser-library-history")).not.toBeNull();
  });

  it("close() hides the panel and pokes the probe again", async () => {
    window.laxBrowserLibrary.open();
    await flush();
    syncSpy.mockClear();
    window.laxBrowserLibrary.close();
    expect(document.getElementById("browser-library-panel")!.style.display).toBe("none");
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(window.laxBrowserLibrary.isOpen()).toBe(false);
  });

  it("'Bookmark current page' POSTs the address-bar url", async () => {
    (document.getElementById("browser-url-input") as HTMLInputElement).value = "https://ex.com/current";
    window.laxBrowserLibrary.open();
    await flush();
    const btn = [...document.querySelectorAll("#browser-library-panel button")]
      .find((b) => b.textContent === "Bookmark current page") as HTMLButtonElement;
    btn.click();
    await flush();
    const post = apiState.calls.find((c) => c.method === "POST" && c.path === "/api/browser/bookmarks");
    expect(post).toBeTruthy();
    expect(JSON.parse(post!.body!)).toEqual({ url: "https://ex.com/current" });
  });

  it("clearing history is double-confirmed before the DELETE fires", async () => {
    apiState.history = [{ id: "hist-1", url: "https://ex.com/a", title: "", ts: Date.now() }];
    window.laxBrowserLibrary.open();
    await flush();
    const clearBtn = [...document.querySelectorAll("#browser-library-panel button")]
      .find((b) => b.textContent === "Clear") as HTMLButtonElement;

    // happy-dom ships no window.confirm — install a controllable one.
    const confirmSpy = vi.fn().mockReturnValueOnce(false);
    (window as unknown as { confirm: unknown }).confirm = confirmSpy;

    // First confirm declined → no DELETE.
    clearBtn.click();
    await flush();
    expect(apiState.calls.some((c) => c.method === "DELETE" && c.path === "/api/browser/history")).toBe(false);

    // Both confirms accepted → DELETE all.
    confirmSpy.mockReturnValue(true);
    clearBtn.click();
    await flush();
    expect(apiState.calls.some((c) => c.method === "DELETE" && c.path === "/api/browser/history")).toBe(true);
  });

  it("refreshSuggestions fills the datalist with unique history urls (labels = titles)", async () => {
    apiState.history = [
      { id: "1", url: "https://ex.com/a", title: "A", ts: 3 },
      { id: "2", url: "https://ex.com/a", title: "A again", ts: 2 }, // duplicate url skipped
      { id: "3", url: "https://ex.com/b", title: "", ts: 1 },
    ];
    await window.laxBrowserLibrary.refreshSuggestions();
    const options = [...document.querySelectorAll("#browser-url-suggestions option")] as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["https://ex.com/a", "https://ex.com/b"]);
    expect(options[0].label).toBe("A");
  });

  it("clicking the browser side-tab refreshes suggestions (cheap, no keystroke queries)", async () => {
    apiState.history = [{ id: "1", url: "https://ex.com/tab", title: "", ts: 1 }];
    (document.getElementById("side-tab-browser") as HTMLButtonElement).click();
    await flush();
    const options = [...document.querySelectorAll("#browser-url-suggestions option")] as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["https://ex.com/tab"]);
  });
});

declare global {
  interface Window {
    laxBrowserLibrary: {
      toggle(): void;
      open(): void;
      close(): void;
      refresh(): Promise<void>;
      refreshSuggestions(): Promise<void>;
      render(bookmarks: unknown[], history: unknown[]): void;
      isOpen(): boolean;
    };
  }
}
