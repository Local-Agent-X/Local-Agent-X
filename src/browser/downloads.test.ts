import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Download, Page } from "playwright";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig } from "../config.js";
import {
  MAX_DOWNLOAD_BYTES,
  downloadsSince,
  formatDownloadNote,
  installDownloadHandler,
  latestDownloadSeq,
  recentDownloads,
} from "./downloads.js";
import { BrowserManager } from "./manager.js";
import type { BrowserObservation } from "./observation.js";
import { handleObserve } from "../tools/browser-tools/observe.js";

// The download handler is the only writer of recentDownloads; these tests
// drive it with a captured page.on("download") listener and fake Download
// objects — no Playwright launch.

type DownloadListener = (d: Download) => Promise<void>;

function captureHandler(sessionKey: string): DownloadListener {
  let listener: DownloadListener | undefined;
  const page = {
    on: vi.fn((_event: string, fn: DownloadListener) => { listener = fn; }),
  } as unknown as Page;
  installDownloadHandler(page, sessionKey);
  if (!listener) throw new Error("download listener not registered");
  return listener;
}

function fakeDownload(name: string, save: (dest: string) => void): Download {
  return {
    url: () => `https://example.com/${name}`,
    suggestedFilename: () => name,
    saveAs: async (dest: string) => { save(dest); },
  } as unknown as Download;
}

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-downloads-"));
  setRuntimeConfig({ workspace } as Partial<LAXConfig> as LAXConfig);
});

afterAll(() => { rmSync(workspace, { recursive: true, force: true }); });

describe("installDownloadHandler — record + size cap", () => {
  it("records name, size, path, and owning session for a completed download", async () => {
    const handler = captureHandler("sess-1");
    await handler(fakeDownload("report.pdf", (dest) => writeFileSync(dest, "pdf-bytes")));

    const rec = recentDownloads[recentDownloads.length - 1];
    expect(rec.name).toBe("report.pdf");
    expect(rec.size).toBe(9);
    expect(rec.path).toBe(join(workspace, "downloads", "report.pdf"));
    expect(rec.sessionKey).toBe("sess-1");
    expect(rec.removedOversize).toBeUndefined();
    expect(existsSync(rec.path)).toBe(true);
  });

  it("deletes an oversized download and records it as removed", async () => {
    const handler = captureHandler("sess-1");
    // Sparse file: stat reports the full logical size without writing 512 MB.
    await handler(fakeDownload("huge.iso", (dest) => {
      const fd = openSync(dest, "w");
      ftruncateSync(fd, MAX_DOWNLOAD_BYTES + 1);
      closeSync(fd);
    }));

    const rec = recentDownloads[recentDownloads.length - 1];
    expect(rec.name).toBe("huge.iso");
    expect(rec.removedOversize).toBe(true);
    expect(existsSync(join(workspace, "downloads", "huge.iso"))).toBe(false);
  });

  it("downloadsSince only returns records after the cursor, scoped to the session", async () => {
    const handler = captureHandler("sess-1");
    const other = captureHandler("sess-2");
    await handler(fakeDownload("a.txt", (dest) => writeFileSync(dest, "a")));
    const cursor = latestDownloadSeq();
    await handler(fakeDownload("b.txt", (dest) => writeFileSync(dest, "b")));
    await other(fakeDownload("c.txt", (dest) => writeFileSync(dest, "c")));

    expect(downloadsSince(cursor, "sess-1").map((d) => d.name)).toEqual(["b.txt"]);
    expect(downloadsSince(cursor, "sess-2").map((d) => d.name)).toEqual(["c.txt"]);
  });
});

describe("formatDownloadNote", () => {
  it("returns empty string when nothing new happened", () => {
    expect(formatDownloadNote([])).toBe("");
  });

  it("surfaces the cap violation in the note", () => {
    const note = formatDownloadNote([
      { url: "u", path: "/x/big.iso", name: "big.iso", size: MAX_DOWNLOAD_BYTES + 1, ts: 1, seq: 1, sessionKey: "s", removedOversize: true },
    ]);
    expect(note).toContain("big.iso");
    expect(note).toContain("exceeds");
    expect(note).toContain("deleted");
  });
});

// Observation surfacing: every formatted observation appends this session's
// downloads completed since the previous one, and only once. Registry + page
// are stubbed; only the download plumbing under test is real.

function emptyObs(): BrowserObservation {
  return {
    url: "https://example.com/", title: "Example", isInitial: true,
    full: [], added: [], removed: [], changed: [],
    offscreenCount: 0, totalCount: 0, currentRefs: [],
    obstructions: [], dialogs: [], crossOriginIframes: [],
  };
}

function stubbedManager(sessionId: string): BrowserManager {
  const mgr = new BrowserManager(sessionId);
  (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi.fn().mockResolvedValue({});
  (mgr as unknown as { registry: { observe: () => Promise<BrowserObservation> } }).registry = {
    observe: async () => emptyObs(),
  };
  return mgr;
}

describe("BrowserManager.snapshot — surfaces this session's new downloads once", () => {
  it("includes downloads completed after session start, then stops repeating them", async () => {
    const handler = captureHandler("snap-sess");
    await handler(fakeDownload("before.txt", (dest) => writeFileSync(dest, "old")));

    const mgr = stubbedManager("snap-sess"); // cursor starts at current seq → "before.txt" is history
    await handler(fakeDownload("fresh.csv", (dest) => writeFileSync(dest, "1,2,3")));

    const first = await mgr.snapshot();
    expect(first).toContain("== DOWNLOADS");
    expect(first).toContain("fresh.csv");
    expect(first).toContain(join(workspace, "downloads"));
    expect(first).not.toContain("before.txt");

    const second = await mgr.snapshot();
    expect(second).not.toContain("== DOWNLOADS");
  });

  it("never surfaces another session's downloads (privacy isolation)", async () => {
    const chatMgr = stubbedManager("chat-sess");
    const missionMgr = stubbedManager("mission-sess");
    const missionHandler = captureHandler("mission-sess");
    await missionHandler(fakeDownload("mission-secret.pdf", (dest) => writeFileSync(dest, "classified")));

    const chatSnap = await chatMgr.snapshot();
    expect(chatSnap).not.toContain("mission-secret");
    expect(chatSnap).not.toContain("== DOWNLOADS");

    const missionSnap = await missionMgr.snapshot();
    expect(missionSnap).toContain("== DOWNLOADS");
    expect(missionSnap).toContain("mission-secret.pdf");
  });
});

describe("observe tool — surfaces downloads through the same funnel", () => {
  it("appends the downloads note to the observe tool's own text assembly", async () => {
    const mgr = stubbedManager("observe-sess");
    const handler = captureHandler("observe-sess");
    await handler(fakeDownload("grabbed.zip", (dest) => writeFileSync(dest, "zipbytes")));

    const first = await handleObserve(mgr);
    expect(first.content).toContain("== DOWNLOADS");
    expect(first.content).toContain("grabbed.zip");

    // Consumed exactly once — a follow-up observe stays quiet.
    const second = await handleObserve(mgr);
    expect(second.content).not.toContain("== DOWNLOADS");
  });
});
