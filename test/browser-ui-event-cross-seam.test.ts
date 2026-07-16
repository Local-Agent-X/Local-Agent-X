/**
 * CROSS-SEAM CONTRACT — the campaign's integration gate.
 *
 * One `ui:browser` event stream (produced by the desktop over the bridge)
 * feeds TWO independent consumers through the ONE event bus:
 *   1. the orchestrator's UI-event store → the "since your last turn" digest
 *      injected into agent context (signals-ui-events),
 *   2. the browser history recorder → ~/.lax/browser-history.json.
 *
 * The contract this test pins:
 *   - both consumers see the SAME event, once each (no double-wiring),
 *   - both apply the SAME privacy law (credential-shaped urls/titles never
 *     survive into either surface),
 *   - the ONE toggle (enableUiEventBus) silences BOTH.
 *
 * Everything here is real: real EventBus, real stores on a temp LAX dir —
 * only the config read is mocked (the toggle must be flippable mid-test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

const mock = vi.hoisted(() => ({ config: { enableUiEventBus: true } as { enableUiEventBus: boolean } }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, getRuntimeConfig: () => mock.config };
});

import { EventBus } from "../src/event-bus.js";
import { _rewireUiEventBusForTest } from "../src/orchestrator/signals-ui-events.js";
import { _resetUiEventStoreForTest, recentUiDigest } from "../src/orchestrator/ui-event-store.js";
import { _rewireHistoryRecorderForTest } from "../src/browser/history-recorder.js";
import { BrowserHistoryStore } from "../src/browser/history-store.js";
import { getLaxDir } from "../src/lax-data-dir.js";

beforeEach(() => {
  // The global test env repoints the LAX dir to a sandbox; the store's file
  // path is frozen at import, so clear the FILE between tests (the same
  // pattern history-store.test.ts uses).
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  mock.config = { enableUiEventBus: true };
  _resetUiEventStoreForTest();
  BrowserHistoryStore._resetForTest();
  _rewireUiEventBusForTest();
  _rewireHistoryRecorderForTest();
});

async function emit(action: string, target: string, sessionId?: string): Promise<void> {
  const event: Record<string, unknown> = { surface: "browser", action, target, ts: Date.now() };
  if (sessionId) event.sessionId = sessionId;
  await EventBus.emit("ui:browser", event);
}

describe("one ui:browser stream → digest AND history, one privacy law, one toggle", () => {
  it("a benign navigation reaches both consumers exactly once", async () => {
    await emit("navigate", "https://news.ycombinator.com/item", "cs-1");
    await emit("title", "Interesting Story", "cs-1");

    const digest = recentUiDigest("cs-1");
    expect(digest).not.toBeNull();
    expect(digest!.text).toContain("news.ycombinator.com/item");
    expect(digest!.eventCount).toBe(2); // once each — no stacked listeners

    const rows = BrowserHistoryStore.getInstance().query({});
    expect(rows).toHaveLength(1); // no double-recording either
    expect(rows[0].url).toBe("https://news.ycombinator.com/item");
    expect(rows[0].title).toBe("Interesting Story");
    // Unregistered session resolves to the default profile.
    expect(rows[0].profileId).toBe("default");
  });

  it("credential-shaped urls and titles survive into NEITHER surface", async () => {
    await emit("navigate", "https://ok.example.com/docs", "cs-2");
    await emit("navigate", "https://bank.example.com/reset-password?token=LIVE-SECRET", "cs-2");
    await emit("title", "Reset password — one-time code 934812", "cs-2");

    const digestText = recentUiDigest("cs-2")!.text;
    const historyJson = JSON.stringify(BrowserHistoryStore.getInstance().query({}));
    for (const surface of [digestText, historyJson]) {
      expect(surface).not.toContain("LIVE-SECRET");
      expect(surface).not.toContain("reset-password");
      expect(surface).not.toContain("934812");
    }
    // The benign visit is still present in both — redaction drops secrets,
    // not the user's ordinary trail.
    expect(digestText).toContain("ok.example.com/docs");
    expect(historyJson).toContain("ok.example.com/docs");
    // And the dropped url's title didn't land on the benign row.
    expect(BrowserHistoryStore.getInstance().query({})[0].title).toBe("");
  });

  it("the ONE toggle silences BOTH consumers, live", async () => {
    await emit("navigate", "https://before.example.com/", "cs-3");
    expect(BrowserHistoryStore.getInstance().query({})).toHaveLength(1);

    mock.config = { enableUiEventBus: false };
    await emit("navigate", "https://after.example.com/", "cs-3");

    expect(recentUiDigest("cs-3")).toBeNull(); // digest side dark
    const rows = BrowserHistoryStore.getInstance().query({});
    expect(rows).toHaveLength(1); // history side dark too
    expect(JSON.stringify(rows)).not.toContain("after.example.com");

    // Flipping back on restores the pre-toggle buffer — and proves the
    // toggled-off event was never ingested anywhere.
    mock.config = { enableUiEventBus: true };
    const restored = recentUiDigest("cs-3");
    expect(restored).not.toBeNull();
    expect(restored!.text).toContain("before.example.com");
    expect(restored!.text).not.toContain("after.example.com");
  });
});
