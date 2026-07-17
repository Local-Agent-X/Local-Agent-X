// Browser downloads bridge (chunk F) — the REAL browser-partition will-download
// quarantine handler (viewId/pageUrl attribution at download time) composed
// with the REAL browser-downloads-bridge outbox: terminal entries are pushed
// as fire-and-forget "lax:browser-download-event" messages, marked reported
// ONLY on a successful send, and the backlog re-flushes on (re)wire. Hermetic:
// electron and desktop config are mocked; no bytes are written (the fake
// DownloadItem just records setSavePath).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  // vi.hoisted runs before imports — build the tmp root from env, not os.tmpdir().
  const tmpRoot = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return {
    tmp: `${tmpRoot}/lax-dlbridge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    listeners,
    fakeSession: {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      on: (event: string, fn: (...args: unknown[]) => void) => { listeners.set(event, fn); },
      webRequest: {
        onBeforeRequest: () => {},
        onCompleted: () => {},
        onErrorOccurred: () => {},
        onHeadersReceived: () => {},
      },
    },
    viewsById: new Map<string, unknown>(),
    poolList: [] as Array<{ viewId: string; partition: string }>,
  };
});

vi.mock("../desktop/node_modules/electron", () => ({
  app: {
    commandLine: { appendSwitch: () => {} },
    whenReady: () => Promise.resolve(),
    configureHostResolver: () => {},
  },
  session: { fromPartition: () => h.fakeSession },
}));
vi.mock("../desktop/src/config", () => ({
  LAX_DIR: h.tmp,
  getLAXConfig: () => ({ port: 7007 }),
}));
vi.mock("../desktop/src/browser-views", () => ({
  getBrowserView: (viewId: string) => h.viewsById.get(viewId),
  listBrowserViews: () => h.poolList,
}));

import {
  getHardenedPartitionSession,
  listQuarantinedDownloads,
  setDownloadContextResolver,
  setDownloadDoneListener,
  _resetDownloadRegistryForTest,
} from "../desktop/src/browser-partition";
import { flushUnreportedDownloads, wireDownloadBridge } from "../desktop/src/browser-downloads-bridge";

const PART = "persist:lax-profile-work";

/** Fake Electron DownloadItem: records setSavePath, lets tests fire done. */
function fakeItem(props: { url: string; filename: string; mime: string; bytes: number }) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    savePath: "",
    setSavePath(p: string) { this.savePath = p; },
    getURL: () => props.url,
    getFilename: () => props.filename,
    getMimeType: () => props.mime,
    getTotalBytes: () => props.bytes,
    getReceivedBytes: () => props.bytes,
    on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
    once(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
    fire(event: string, ...args: unknown[]) { handlers.get(event)?.(...args); },
  };
}

function fakeWc(id: number, url = "https://page.example/downloads") {
  return { id, isDestroyed: () => false, getURL: () => url };
}

/** Fires the partition's will-download handler the way Electron would. */
function triggerDownload(item: ReturnType<typeof fakeItem>, wc?: unknown) {
  getHardenedPartitionSession(PART); // idempotent; ensures the handler exists
  const handler = h.listeners.get("will-download");
  expect(handler).toBeDefined();
  handler!({}, item, wc);
}

afterAll(() => {
  rmSync(h.tmp, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDownloadRegistryForTest();
  setDownloadContextResolver(null);
  setDownloadDoneListener(null);
  h.viewsById.clear();
  h.poolList = [];
});

describe("attribution + quarantine registry (browser-partition)", () => {
  it("attributes a download to the pool view whose webContents triggered it, at DOWNLOAD time", () => {
    h.poolList = [{ viewId: "view-s-1-work", partition: PART }];
    h.viewsById.set("view-s-1-work", { webContents: fakeWc(42) });
    wireDownloadBridge(vi.fn(() => true));
    const item = fakeItem({ url: "https://files.test/a.pdf", filename: "a.pdf", mime: "application/pdf", bytes: 9 });
    triggerDownload(item, fakeWc(42));
    const [entry] = listQuarantinedDownloads();
    expect(entry.viewId).toBe("view-s-1-work");
    expect(entry.pageUrl).toBe("https://page.example/downloads");
    expect(entry.state).toBe("progressing");
    expect(entry.reported).toBe(false);
    // Quarantine discipline unchanged: saved under <LAX_DIR>/quarantine/<id>.part.
    expect(item.savePath).toBe(join(h.tmp, "quarantine", `${entry.id}.part`));
    expect(entry.savePath).toBe(item.savePath);
  });

  it("a webContents outside the pool (popup) → viewId null; no resolver wired → null too", () => {
    wireDownloadBridge(vi.fn(() => true));
    const popup = fakeItem({ url: "https://files.test/p.pdf", filename: "p.pdf", mime: "application/pdf", bytes: 1 });
    triggerDownload(popup, fakeWc(999));
    expect(listQuarantinedDownloads()[0].viewId).toBeNull();

    setDownloadContextResolver(null); // pre-wire world
    const orphan = fakeItem({ url: "https://files.test/o.pdf", filename: "o.pdf", mime: "application/pdf", bytes: 1 });
    triggerDownload(orphan, fakeWc(42));
    const entries = listQuarantinedDownloads();
    expect(entries[1].viewId).toBeNull();
    expect(entries[1].pageUrl).toBe("");
  });

  it("a throwing resolver never breaks the quarantine save", () => {
    setDownloadContextResolver(() => { throw new Error("resolver bug"); });
    const item = fakeItem({ url: "https://files.test/x.pdf", filename: "x.pdf", mime: "application/pdf", bytes: 1 });
    expect(() => triggerDownload(item, fakeWc(1))).not.toThrow();
    const [entry] = listQuarantinedDownloads();
    expect(entry.viewId).toBeNull();
    expect(item.savePath).toContain(".part"); // quarantine still enforced
  });
});

describe("terminal-entry push outbox (browser-downloads-bridge)", () => {
  it("done → one lax:browser-download-event with the full wire payload; reported entries never re-send", () => {
    h.poolList = [{ viewId: "view-s-1-work", partition: PART }];
    h.viewsById.set("view-s-1-work", { webContents: fakeWc(42) });
    const sink = vi.fn(() => true);
    wireDownloadBridge(sink);
    const item = fakeItem({ url: "https://files.test/a.zip", filename: "a.zip", mime: "application/zip", bytes: 12 });
    triggerDownload(item, fakeWc(42));
    expect(sink).not.toHaveBeenCalled(); // progressing entries are never pushed
    item.fire("done", {}, "completed");
    const [entry] = listQuarantinedDownloads();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      type: "lax:browser-download-event",
      viewId: "view-s-1-work",
      download: {
        id: entry.id, url: "https://files.test/a.zip", pageUrl: "https://page.example/downloads",
        filename: "a.zip", mime: "application/zip", bytes: 12, state: "completed", savePath: entry.savePath,
      },
    });
    expect(entry.reported).toBe(true);
    flushUnreportedDownloads();
    expect(sink).toHaveBeenCalledTimes(1); // idempotent: reported entries stay sent-once
  });

  it("a failed send leaves the entry unreported; the next (re)wire flushes it exactly once", () => {
    const deadSink = vi.fn(() => false); // child gone: proc.send returned false
    wireDownloadBridge(deadSink);
    const item = fakeItem({ url: "https://files.test/b.pdf", filename: "b.pdf", mime: "application/pdf", bytes: 3 });
    triggerDownload(item, fakeWc(7));
    item.fire("done", {}, "completed");
    expect(deadSink).toHaveBeenCalledTimes(1);
    expect(listQuarantinedDownloads()[0].reported).toBe(false);

    const liveSink = vi.fn(() => true); // server respawned → re-wire flushes backlog
    wireDownloadBridge(liveSink);
    expect(liveSink).toHaveBeenCalledTimes(1);
    expect(listQuarantinedDownloads()[0].reported).toBe(true);
    flushUnreportedDownloads();
    expect(liveSink).toHaveBeenCalledTimes(1);
  });

  it("cancelled/interrupted downloads are pushed too (the server records the failure); progressing never is", () => {
    const sink = vi.fn(() => true);
    wireDownloadBridge(sink);
    const gone = fakeItem({ url: "https://files.test/c.pdf", filename: "c.pdf", mime: "application/pdf", bytes: 5 });
    triggerDownload(gone, fakeWc(7));
    gone.fire("done", {}, "interrupted");
    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0][0] as { download: { state: string } }).download.state).toBe("interrupted");

    const inflight = fakeItem({ url: "https://files.test/d.pdf", filename: "d.pdf", mime: "application/pdf", bytes: 5 });
    triggerDownload(inflight, fakeWc(7)); // never done
    flushUnreportedDownloads();
    expect(sink).toHaveBeenCalledTimes(1); // still just the interrupted one
  });

  it("a throwing sink never breaks the item's done handler and leaves the entry unreported", () => {
    wireDownloadBridge((() => { throw new Error("channel closed"); }) as never);
    const item = fakeItem({ url: "https://files.test/e.pdf", filename: "e.pdf", mime: "application/pdf", bytes: 2 });
    triggerDownload(item, fakeWc(7));
    expect(() => item.fire("done", {}, "completed")).not.toThrow();
    expect(listQuarantinedDownloads()[0].reported).toBe(false);
  });
});
