import { describe, it, expect } from "vitest";
import type { BrowserBackend } from "../../browser/index.js";
import { handleNewTab } from "./navigation.js";

/**
 * Multi-URL new_tab must be wedge-resilient. Opening N tabs sequentially can
 * outrun the browser tool's in-process wedge deadline (index.ts fires
 * resetWedgedBrowser at ~toolMs-1s), which force-recovers the session and DROPS
 * every tab already opened — then tells the agent to "retry", so a 10-URL call
 * re-wedges forever. The fan-out therefore carries a time budget (from the
 * canonical getToolTimeout) and stops STARTING new tabs at ~70% of it, RETURNING
 * a partial report instead of running past the deadline.
 *
 * These tests drive the budget with an INJECTED CLOCK — the fake newTab()
 * advances it to model a slow desktop-side open — so the stop-early path is
 * deterministic and the test never sleeps.
 */

interface FakeOpts {
  getCurrentUrl?: () => string;
  newTab?: (url: string) => Promise<string>;
  snapshot?: () => Promise<string>;
}

function fakeManager(over: FakeOpts = {}): BrowserBackend {
  return {
    getProfileId: () => "default",
    getCurrentUrl: () => "https://example.com/",
    snapshot: async () => "[1]<main>ready</main>",
    newTab: async (url: string) => `opened ${url}`,
    ...over,
  } as unknown as BrowserBackend;
}

const SIX = [
  "https://a.test/", "https://b.test/", "https://c.test/",
  "https://d.test/", "https://e.test/", "https://f.test/",
];

describe("handleNewTab multi-URL time budget (wedge-resilience)", () => {
  it("stops opening tabs once the budget headroom is spent and reports opened vs not-attempted", async () => {
    // Each newTab costs 3s of injected-clock time. toolTimeoutMs=12000 →
    // budget=max(1000,11000)=11000, stop threshold=0.7*11000=7700ms. So a,b,c
    // open (clock 3k,6k,9k) and before d the elapsed 9000 ≥ 7700 → stop.
    let clock = 0;
    const openedUrls: string[] = [];
    const manager = fakeManager({
      newTab: async (url) => { clock += 3_000; openedUrls.push(url); return `opened ${url}`; },
    });

    const r = await handleNewTab(manager, { urls: SIX }, { now: () => clock, toolTimeoutMs: 12_000 });

    // Stopped early: only the first three were attempted.
    expect(openedUrls).toEqual(SIX.slice(0, 3));
    expect(r.isError).toBeFalsy();
    // Report must state (a) how many opened, (b) which were skipped, and (c)
    // the follow-up path.
    expect(r.content).toContain("Opened 3 of 6 tabs.");
    expect(r.content).toContain("Stopped early to stay within the browser time budget");
    expect(r.content).toContain("3 URL(s) not attempted");
    for (const u of ["https://d.test/", "https://e.test/", "https://f.test/"]) {
      expect(r.content).toContain(u);
    }
    expect(r.content).toContain("follow-up new_tab call");
    // Returned UNDER the wedge deadline (budget=11000): the elapsed clock at
    // return is well below it, so the outer wedge never fires and the opened
    // tabs survive.
    expect(clock).toBeLessThan(11_000);
  });

  it("opens the whole batch when the budget is ample — no early-stop note", async () => {
    let clock = 0;
    const openedUrls: string[] = [];
    const manager = fakeManager({
      newTab: async (url) => { clock += 100; openedUrls.push(url); return `opened ${url}`; },
    });
    const r = await handleNewTab(manager, { urls: SIX }, { now: () => clock, toolTimeoutMs: 30_000 });
    expect(openedUrls).toEqual(SIX);
    expect(r.content).toContain("Opened 6 of 6 tabs.");
    expect(r.content).not.toContain("Stopped early");
    expect(r.content).not.toContain("not attempted");
  });

  it("treats an unbounded tool timeout as no budget — the whole batch opens", async () => {
    let clock = 0;
    const openedUrls: string[] = [];
    const manager = fakeManager({
      newTab: async (url) => { clock += 60_000; openedUrls.push(url); return `opened ${url}`; },
    });
    // toolTimeoutMs<=0 means the operator set the tool unbounded; the wedge
    // disarms too, so the fan-out must not stop early despite huge per-tab cost.
    const r = await handleNewTab(manager, { urls: SIX }, { now: () => clock, toolTimeoutMs: 0 });
    expect(openedUrls).toEqual(SIX);
    expect(r.content).toContain("Opened 6 of 6 tabs.");
    expect(r.content).not.toContain("Stopped early");
  });

  it("a per-URL failure does not abort the fan-out (on the real canonical timeout)", async () => {
    const openedUrls: string[] = [];
    const manager = fakeManager({
      newTab: async (url) => {
        if (url.includes("b.test")) throw new Error("nav boom");
        openedUrls.push(url);
        return `opened ${url}`;
      },
    });
    // No deps: exercises getToolTimeout(BROWSER_TOOL_NAME) + Date.now for real.
    // Instant newTabs stay far under the budget, so nothing stops early.
    const r = await handleNewTab(manager, { urls: SIX.slice(0, 3) });
    // b threw but a and c still opened, and the loop kept going.
    expect(openedUrls).toEqual(["https://a.test/", "https://c.test/"]);
    expect(r.content).toContain("Opened 2 of 3 tabs.");
    expect(r.content).toContain("Error: nav boom");
  });

  it("does not touch the single-URL path: opens one tab and appends a snapshot, no budget summary", async () => {
    const openedUrls: string[] = [];
    const manager = fakeManager({
      newTab: async (url) => { openedUrls.push(url); return `opened ${url}`; },
    });
    const r = await handleNewTab(manager, { url: "https://solo.test/" });
    expect(openedUrls).toEqual(["https://solo.test/"]);
    expect(r.isError).toBeFalsy();
    // Single-URL path returns the raw tab result + deep snapshot, never the
    // multi-URL "Opened N of M" summary or the budget note.
    expect(r.content).toContain("opened https://solo.test/");
    expect(r.content).toContain("--- Page snapshot ---");
    expect(r.content).not.toContain("Opened 1 of");
    expect(r.content).not.toContain("Stopped early");
  });
});
