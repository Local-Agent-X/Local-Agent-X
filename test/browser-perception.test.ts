// Browser perception (chunk E) — desktop-side console/network rings, the
// view-lifecycle wiring seam, the read-console/read-network bridge ops, the
// real-HTTP-status navigate reply, and UI-event production for USER views.
// All hermetic: electron never loads (browser-views/partition/ipc mocked),
// browser-perception itself is a pure leaf and runs for real.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const h = vi.hoisted(() => ({
  viewsById: new Map<string, unknown>(),
  poolList: [] as unknown[],
  lifecycleObserver: null as null | {
    onViewCreated(viewId: string, wc: unknown, agentDriven: boolean): void;
    onViewClosed(viewId: string): void;
  },
  egressEvaluator: null as unknown,
}));

vi.mock("../desktop/src/browser-views", () => ({
  createBrowserView: () => ({}),
  closeBrowserView: () => {},
  getBrowserView: (viewId: string) => h.viewsById.get(viewId),
  listBrowserViews: () => h.poolList,
  clearAdoptedViews: () => {},
  pingBrowserView: () => ({ ok: true }),
  hideBrowserView: () => {},
  setBrowserViewBounds: () => {},
  showBrowserView: () => {},
  setViewLifecycleObserver: (obs: typeof h.lifecycleObserver) => { h.lifecycleObserver = obs; },
  setPoolChangedListener: () => {},
}));
vi.mock("../desktop/src/browser-partition", () => ({
  getHardenedPartitionSession: () => ({ clearStorageData: async () => {} }),
  setEgressEvaluator: (fn: unknown) => { h.egressEvaluator = fn; },
  setViewTrustResolver: () => {},
  // Chunk F seams (browser-downloads-bridge wires these on every respawn).
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
  attachViewPerception,
  detachViewPerception,
  markAgentNavigation,
  noteRequestDone,
  noteRequestFailed,
  noteRequestStart,
  pushBounded,
  readConsoleEntries,
  readNetworkEntries,
  setBrowserUiEventSink,
  trimText,
  CONSOLE_MESSAGE_MAX_CHARS,
  RING_MAX_ENTRIES,
  UI_TITLE_MAX_CHARS,
  _resetBrowserPerceptionForTest,
} from "../desktop/src/browser-perception";
import { handleBrowserBridgeMessage, wireBrowserEgressEvaluator } from "../desktop/src/server-bridge-browser";
import { isDataEndpoint, formatNetworkReport } from "../src/browser/bridge-perception";

/** EventEmitter-ish fake webContents that records on/off and can fire events. */
function fakeWc() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    destroyed: false,
    offCalls: [] as string[],
    isDestroyed(): boolean { return this.destroyed; },
    getURL: () => "https://example.com/",
    getTitle: () => "Example",
    stop: () => {},
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return this;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      this.offCalls.push(event);
      listeners.get(event)?.delete(fn);
      return this;
    },
    fire(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    listenerCount(event: string): number { return listeners.get(event)?.size ?? 0; },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetBrowserPerceptionForTest();
  h.viewsById.clear();
  h.poolList = [];
  h.lifecycleObserver = null;
});

describe("bounded ring helpers (pure)", () => {
  it("pushBounded drops the OLDEST entries past the cap", () => {
    const ring: number[] = [];
    for (let i = 0; i < RING_MAX_ENTRIES + 25; i++) pushBounded(ring, i);
    expect(ring.length).toBe(RING_MAX_ENTRIES);
    expect(ring[0]).toBe(25); // oldest 25 fell off the front
    expect(ring[ring.length - 1]).toBe(RING_MAX_ENTRIES + 24);
  });

  it("trimText caps long text with an ellipsis and stringifies non-strings", () => {
    const long = "x".repeat(500);
    const trimmed = trimText(long, CONSOLE_MESSAGE_MAX_CHARS);
    expect(trimmed.length).toBe(CONSOLE_MESSAGE_MAX_CHARS);
    expect(trimmed.endsWith("…")).toBe(true);
    expect(trimText("short", 300)).toBe("short");
    expect(trimText(undefined, 10)).toBe("");
  });
});

describe("per-view console ring", () => {
  it("captures console messages in BOTH Electron signatures, plus crash/unresponsive as errors", () => {
    const wc = fakeWc();
    attachViewPerception("v1", wc as never, true);
    wc.fire("console-message", {}, 3, "legacy error line");            // legacy positional
    wc.fire("console-message", { level: "warning", message: "new-style warn" }); // event object
    wc.fire("render-process-gone", {}, { reason: "crashed" });
    wc.fire("unresponsive");
    const entries = readConsoleEntries("v1");
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ["error", "legacy error line"],
      ["warning", "new-style warn"],
      ["error", "renderer process gone (crashed)"],
      ["error", "page became unresponsive"],
    ]);
    for (const e of entries) expect(e.ts).toBeGreaterThan(0);
  });

  it("trims messages to the cap and bounds the ring at RING_MAX_ENTRIES", () => {
    const wc = fakeWc();
    attachViewPerception("v1", wc as never, true);
    for (let i = 0; i < RING_MAX_ENTRIES + 10; i++) wc.fire("console-message", {}, 1, `m${i}` + "y".repeat(400));
    const entries = readConsoleEntries("v1");
    expect(entries.length).toBe(RING_MAX_ENTRIES);
    expect(entries[0].message.startsWith("m10")).toBe(true);
    expect(entries[0].message.length).toBe(CONSOLE_MESSAGE_MAX_CHARS);
  });

  it("detach clears the ring and removes the view's listeners (no leak on close)", () => {
    const wc = fakeWc();
    attachViewPerception("v1", wc as never, true);
    wc.fire("console-message", {}, 2, "warn");
    expect(readConsoleEntries("v1").length).toBe(1);
    detachViewPerception("v1");
    expect(readConsoleEntries("v1")).toEqual([]);
    expect(wc.listenerCount("console-message")).toBe(0);
    expect(wc.listenerCount("did-navigate")).toBe(0);
    wc.fire("console-message", {}, 3, "after close"); // must not resurrect the ring
    expect(readConsoleEntries("v1")).toEqual([]);
  });

  it("an unknown view reads as an empty ring", () => {
    expect(readConsoleEntries("ghost")).toEqual([]);
  });
});

describe("per-partition network ring", () => {
  const PART = "persist:lax-profile-work";

  it("records completions with status and failures with error, newest last, in-flight balanced", () => {
    noteRequestStart(PART, 1);
    noteRequestStart(PART, 2);
    noteRequestStart(PART, 3);
    noteRequestDone(PART, { id: 1, url: "https://api.example/ok", method: "GET", statusCode: 200 });
    noteRequestFailed(PART, { id: 2, url: "https://api.example/dead", method: "POST", error: "net::ERR_FAILED" });
    const { entries, inFlight } = readNetworkEntries(PART);
    expect(inFlight).toBe(1);
    expect(entries.map((e) => [e.method, e.status, e.error])).toEqual([
      ["GET", 200, undefined],
      ["POST", undefined, "net::ERR_FAILED"],
    ]);
  });

  it("stores resourceType + contentType on completions and resourceType on failures", () => {
    noteRequestStart(PART, 1);
    noteRequestStart(PART, 2);
    noteRequestDone(PART, {
      id: 1, url: "https://api.example/data.json", method: "GET", statusCode: 200,
      resourceType: "xhr", contentType: "application/json",
    });
    noteRequestFailed(PART, { id: 2, url: "https://api.example/dead", method: "POST", error: "net::ERR_FAILED", resourceType: "xhr" });
    const { entries } = readNetworkEntries(PART);
    expect(entries.map((e) => [e.resourceType, e.contentType])).toEqual([
      ["xhr", "application/json"],
      ["xhr", undefined], // no response on a failure → no contentType
    ]);
  });

  it("bounds an oversized contentType at store time (skeptic: attacker-controlled header)", () => {
    noteRequestStart(PART, 5);
    noteRequestDone(PART, {
      id: 5, url: "https://api.example/x", method: "GET", statusCode: 200,
      resourceType: "xhr", contentType: "a".repeat(5000),
    });
    const { entries } = readNetworkEntries(PART);
    const last = entries[entries.length - 1];
    expect(last.contentType!.length).toBeLessThanOrEqual(100);
  });

  it("redirect chains do NOT drift the in-flight count (skeptic regression)", () => {
    // A redirect re-enters onBeforeRequest with the SAME request id per hop;
    // onCompleted fires once for the whole chain. The old raw counter ended
    // at +N per N-hop redirect; the unsettled-id set must end at zero.
    noteRequestStart(PART, 7); // hop 1: http://x/
    noteRequestStart(PART, 7); // hop 2: https://x/ (redirect re-entry, same id)
    noteRequestStart(PART, 7); // hop 3: https://www.x/
    noteRequestDone(PART, { id: 7, url: "https://www.x/", method: "GET", statusCode: 200 });
    expect(readNetworkEntries(PART).inFlight).toBe(0);
    // Denied hop settles through onErrorOccurred — also zero.
    noteRequestStart(PART, 8);
    noteRequestStart(PART, 8);
    noteRequestFailed(PART, { id: 8, url: "https://evil/", method: "GET", error: "net::ERR_BLOCKED_BY_CLIENT" });
    expect(readNetworkEntries(PART).inFlight).toBe(0);
  });

  it("stores urls WITHOUT query/fragment/userinfo (skeptic regression)", () => {
    noteRequestStart(PART, 9);
    noteRequestDone(PART, { id: 9, url: "https://alice:hunter2@api.example/data?session_token=SECRET#access=1", method: "GET", statusCode: 200 });
    const { entries } = readNetworkEntries(PART);
    const last = entries[entries.length - 1];
    expect(last.url).toBe("https://api.example/data");
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });

  it("in-flight never goes negative and the ring stays bounded", () => {
    noteRequestDone(PART, { id: 100, url: "https://a/", method: "GET", statusCode: 204 }); // no matching start
    expect(readNetworkEntries(PART).inFlight).toBe(0);
    for (let i = 0; i < RING_MAX_ENTRIES + 5; i++) {
      noteRequestDone(PART, { id: 200 + i, url: `https://a/${i}`, method: "GET", statusCode: 200 });
    }
    expect(readNetworkEntries(PART).entries.length).toBe(RING_MAX_ENTRIES);
  });

  it("an uncaptured partition reads as empty with zero in flight", () => {
    expect(readNetworkEntries("persist:lax-profile-never")).toEqual({ entries: [], inFlight: 0 });
  });
});

describe("UI-event production (user views only)", () => {
  it("user views (agentDriven:false) emit tab-open / navigate / title / tab-close through the sink", () => {
    const sink = vi.fn();
    setBrowserUiEventSink(sink);
    const wc = fakeWc();
    attachViewPerception("user-1", wc as never, false);
    wc.fire("did-navigate", {}, "https://example.com/inbox");
    wc.fire("page-title-updated", {}, "T".repeat(200)); // must truncate
    detachViewPerception("user-1");
    const msgs = sink.mock.calls.map(([m]) => m as Record<string, unknown>);
    expect(msgs.map((m) => m.action)).toEqual(["tab-open", "navigate", "title", "tab-close"]);
    for (const m of msgs) {
      expect(m.type).toBe("lax:browser-ui-event");
      expect(m.surface).toBe("browser");
      expect(m.viewId).toBe("user-1");
      expect(m.id).toBeUndefined(); // fire-and-forget: no id, no reply
      expect(typeof m.ts).toBe("number");
    }
    expect((msgs[1].target as string)).toBe("https://example.com/inbox");
    expect((msgs[2].target as string).length).toBe(UI_TITLE_MAX_CHARS);
  });

  it("agent-driven views NEVER emit UI events (their activity is the agent's own)", () => {
    const sink = vi.fn();
    setBrowserUiEventSink(sink);
    const wc = fakeWc();
    attachViewPerception("view-sess-1-work", wc as never, true);
    wc.fire("did-navigate", {}, "https://agent.example/");
    wc.fire("page-title-updated", {}, "Agent Page");
    detachViewPerception("view-sess-1-work");
    expect(sink).not.toHaveBeenCalled();
  });

  it("a throwing sink never breaks the view's event handlers", () => {
    setBrowserUiEventSink(() => { throw new Error("channel closed"); });
    const wc = fakeWc();
    expect(() => {
      attachViewPerception("user-2", wc as never, false);
      wc.fire("did-navigate", {}, "https://x.example/");
    }).not.toThrow();
  });

  it("agent-initiated navigations on an ADOPTED user view are NOT narrated as user activity (skeptic regression)", () => {
    const sink = vi.fn();
    setBrowserUiEventSink(sink);
    const wc = fakeWc();
    attachViewPerception("foreground", wc as never, false); // user view, later adopted
    sink.mockClear(); // drop the tab-open

    // Bridge navigate marks, then the load's did-navigate + title fire:
    markAgentNavigation("foreground");
    wc.fire("did-navigate", {}, "https://x.com/compose");
    wc.fire("page-title-updated", {}, "Compose post");
    expect(sink).not.toHaveBeenCalled();

    // The USER's next navigation on the same view emits again.
    wc.fire("did-navigate", {}, "https://news.example/");
    wc.fire("page-title-updated", {}, "News");
    const actions = sink.mock.calls.map(([m]) => (m as Record<string, unknown>).action);
    expect(actions).toEqual(["navigate", "title"]);
  });
});

describe("bridge ops + wiring (server-bridge-browser.ts)", () => {
  let proc: { send: Mock; connected: boolean; killed: boolean };

  beforeEach(() => {
    proc = { send: vi.fn(() => true), connected: true, killed: false };
  });

  it("wireBrowserEgressEvaluator arms the lifecycle observer and the UI-event sink onto proc.send", () => {
    wireBrowserEgressEvaluator(proc as never);
    expect(h.lifecycleObserver).not.toBeNull();
    // Observer wires perception for real: create a user view through it.
    const wc = fakeWc();
    h.lifecycleObserver!.onViewCreated("user-5", wc as never, false);
    wc.fire("did-navigate", {}, "https://example.com/");
    expect(proc.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lax:browser-ui-event", action: "navigate", viewId: "user-5" }),
    );
    // A dead child drops events instead of throwing.
    proc.connected = false;
    proc.send.mockClear();
    wc.fire("did-navigate", {}, "https://example.com/2");
    expect(proc.send).not.toHaveBeenCalled();
    h.lifecycleObserver!.onViewClosed("user-5");
  });

  it("lax:browser-read-console replies with the view's ring entries", async () => {
    const wc = fakeWc();
    h.viewsById.set("v1", { webContents: wc });
    attachViewPerception("v1", wc as never, true);
    wc.fire("console-message", {}, 3, "boom");
    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-read-console", id: 11, viewId: "v1" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-read-console-result", id: 11, ok: true,
      entries: [expect.objectContaining({ level: "error", message: "boom" })],
    }));
  });

  it("lax:browser-read-console on an unknown view fails typed (ok:false)", async () => {
    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-read-console", id: 12, viewId: "ghost" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-read-console-result", id: 12, ok: false,
      error: expect.stringContaining('no browser view "ghost"'),
    }));
  });

  it("lax:browser-read-network resolves the view's PARTITION and returns its ring + inFlight", async () => {
    const PART = "persist:lax-profile-work";
    h.poolList = [{ viewId: "v1", partition: PART, agentDriven: true }];
    noteRequestStart(PART, 1);
    noteRequestDone(PART, { id: 1, url: "https://api.example/x", method: "GET", statusCode: 500 });
    noteRequestStart(PART, 2);
    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-read-network", id: 13, viewId: "v1" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-read-network-result", id: 13, ok: true,
      network: {
        entries: [expect.objectContaining({ method: "GET", status: 500 })],
        inFlight: 1,
      },
    }));
  });

  it("lax:browser-read-network on an unknown view fails typed (ok:false)", async () => {
    await handleBrowserBridgeMessage(proc as never, { type: "lax:browser-read-network", id: 14, viewId: "ghost" });
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-read-network-result", id: 14, ok: false,
    }));
  });

  it("navigate reply carries the main-frame HTTP status from did-navigate", async () => {
    const wc = fakeWc();
    (wc as { loadURL?: unknown }).loadURL = () => Promise.resolve();
    h.viewsById.set("v9", { webContents: wc });
    h.poolList = [];
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-navigate", id: 21, viewId: "v9", url: "https://example.com/" },
    );
    // Real Electron ordering: loadURL fires did-start-loading before any
    // navigate/finish event — navigate-settle gates success on it.
    wc.fire("did-start-loading");
    wc.fire("did-navigate", {}, "https://example.com/", 404, "Not Found");
    wc.fire("did-finish-load");
    await flush();
    expect(proc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "lax:browser-navigate-result", id: 21, ok: true, status: 404,
    }));
  });

  it("navigate reply omits status when no did-navigate fired (non-HTTP load)", async () => {
    const wc = fakeWc();
    (wc as { loadURL?: unknown }).loadURL = () => Promise.resolve();
    h.viewsById.set("v9", { webContents: wc });
    await handleBrowserBridgeMessage(
      proc as never,
      { type: "lax:browser-navigate", id: 22, viewId: "v9", url: "about:blank" },
    );
    wc.fire("did-start-loading");
    wc.fire("did-finish-load");
    await flush();
    const reply = proc.send.mock.calls.map(([m]) => m as Record<string, unknown>)
      .find((m) => m.type === "lax:browser-navigate-result" && m.id === 22);
    expect(reply).toBeDefined();
    expect(reply!.ok).toBe(true);
    expect("status" in reply!).toBe(false);
  });
});

describe("data-endpoint classification + replay-candidate report", () => {
  it("isDataEndpoint: xhr/fetch resourceType and structured MIMEs are true; chrome is false", () => {
    const at = (partial: Partial<import("../src/browser/bridge-perception").BridgeNetworkEntry>) =>
      ({ url: "https://x/", method: "GET", ts: 1, ...partial });
    expect(isDataEndpoint(at({ resourceType: "xhr" }))).toBe(true);
    expect(isDataEndpoint(at({ resourceType: "fetch" }))).toBe(true);
    expect(isDataEndpoint(at({ contentType: "application/json" }))).toBe(true);
    expect(isDataEndpoint(at({ contentType: "application/rss+xml" }))).toBe(true);
    expect(isDataEndpoint(at({ contentType: "application/vnd.api+json" }))).toBe(true);
    // charset params are not part of the path-only capture, but be robust to case:
    expect(isDataEndpoint(at({ contentType: "APPLICATION/JSON" }))).toBe(true);
    expect(isDataEndpoint(at({ resourceType: "document", contentType: "text/html" }))).toBe(false);
    expect(isDataEndpoint(at({ resourceType: "image" }))).toBe(false);
    expect(isDataEndpoint(at({ resourceType: "stylesheet" }))).toBe(false);
    expect(isDataEndpoint({ url: "https://x/", method: "GET", ts: 1 })).toBe(false); // empty
  });

  it("formatNetworkReport surfaces ONLY GET data endpoints that completed OK", () => {
    const entries: import("../src/browser/bridge-perception").BridgeNetworkEntry[] = [
      { url: "https://api.example/data", method: "GET", status: 200, resourceType: "xhr", contentType: "application/json", ts: 1 },
      { url: "https://cdn.example/logo.png", method: "GET", status: 200, resourceType: "image", contentType: "image/png", ts: 2 },
      { url: "https://api.example/submit", method: "POST", status: 200, resourceType: "xhr", contentType: "application/json", ts: 3 },
      { url: "https://api.example/dead", method: "GET", error: "net::ERR_FAILED", resourceType: "xhr", ts: 4 },
    ];
    const report = formatNetworkReport(entries, 0);
    // Isolate the replay section (the top per-request list always names every
    // request, so scope the negative checks to the appended section only).
    const section = report.slice(report.indexOf("API/data endpoints observed"));
    expect(section).toContain("API/data endpoints observed");
    expect(section).toContain("  GET 200 application/json https://api.example/data");
    // the appended section must NOT list the image, the POST, or the failed xhr:
    expect(section).not.toContain("logo.png");
    expect(section).not.toContain("submit");
    expect(section).not.toContain("dead");
  });

  it("formatNetworkReport dedupes a polled endpoint, newest occurrence last", () => {
    const entries: import("../src/browser/bridge-perception").BridgeNetworkEntry[] = [
      { url: "https://api.example/poll", method: "GET", status: 200, resourceType: "xhr", contentType: "application/json", ts: 1 },
      { url: "https://api.example/poll", method: "GET", status: 200, resourceType: "xhr", contentType: "application/json", ts: 2 },
    ];
    const report = formatNetworkReport(entries, 0);
    const rows = report.split("\n").filter((l) => l.includes("api.example/poll") && l.startsWith("  GET"));
    expect(rows.length).toBe(1);
  });

  it("formatNetworkReport appends NO section when no entry classifies (byte-check)", () => {
    const entries: import("../src/browser/bridge-perception").BridgeNetworkEntry[] = [
      { url: "https://api.example/x", method: "GET", status: 500, ts: 1 },
      { url: "https://api.example/y", method: "POST", error: "net::ERR_FAILED", ts: 2 },
    ];
    const report = formatNetworkReport(entries, 3);
    expect(report).not.toContain("API/data endpoints observed");
    expect(report.endsWith("3 request(s) in flight")).toBe(true);
  });

  it("formatNetworkReport EXCLUDES non-2xx data endpoints (skeptic: 401/403/404/500 only 'worked' via session cookies)", () => {
    const entries: import("../src/browser/bridge-perception").BridgeNetworkEntry[] = [
      { url: "https://api.example/protected", method: "GET", status: 403, resourceType: "xhr", contentType: "application/json", ts: 1 },
      { url: "https://api.example/missing", method: "GET", status: 404, resourceType: "xhr", contentType: "application/json", ts: 2 },
      { url: "https://api.example/boom", method: "GET", status: 500, resourceType: "xhr", contentType: "application/json", ts: 3 },
      { url: "https://api.example/moved", method: "GET", status: 302, resourceType: "xhr", contentType: "application/json", ts: 4 },
      { url: "https://api.example/ok", method: "GET", status: 200, resourceType: "xhr", contentType: "application/json", ts: 5 },
    ];
    const report = formatNetworkReport(entries, 0);
    const section = report.slice(report.indexOf("API/data endpoints observed"));
    expect(section).toContain("  GET 200 application/json https://api.example/ok");
    for (const bad of ["protected", "missing", "boom", "moved"]) expect(section).not.toContain(bad);
  });

  it("formatNetworkReport caps the section at 12 rows and discloses the rest (skeptic: tracking chatter flood)", () => {
    const entries: import("../src/browser/bridge-perception").BridgeNetworkEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ url: `https://api.example/e${i}`, method: "GET", status: 200, resourceType: "fetch", contentType: "application/json", ts: i });
    }
    const report = formatNetworkReport(entries, 0);
    const section = report.slice(report.indexOf("API/data endpoints observed"));
    const rows = section.split("\n").filter((l) => l.startsWith("  GET"));
    expect(rows.length).toBe(12);
    expect(section).toContain("(+8 older not shown)");
    // the 12 shown are the most-recent (newest-last): e8..e19 kept, e0..e7 dropped.
    expect(rows.some((r) => r.endsWith("/e19"))).toBe(true);
    expect(rows.some((r) => r.endsWith("/e7"))).toBe(false);
    expect(rows.some((r) => r.endsWith("/e0"))).toBe(false);
  });
});
