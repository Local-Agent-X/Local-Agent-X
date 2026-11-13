// The "after each chat" interval queues a push through the same 5 s debounce
// as any other change, and a change that lands while a push is running is
// pushed after it rather than dropped.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSync } from "./index.js";

let dataDir: string;
afterEach(() => { vi.useRealTimers(); if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });

function syncWith(interval: string): AgentSync {
  dataDir = mkdtempSync(join(tmpdir(), "lax-after-chat-"));
  writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: "https://example.invalid/r.git", interval }));
  return new AgentSync(dataDir, () => undefined);
}

describe("AgentSync.onChatEnd", () => {
  it("pushes once, after the quiet period, for a burst of turns", async () => {
    vi.useFakeTimers();
    const sync = syncWith("after_chat");
    const push = vi.spyOn(sync, "push").mockResolvedValue({ success: true, message: "Synced" });
    sync.onChatEnd(); sync.onChatEnd();
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does nothing on another interval", async () => {
    vi.useFakeTimers();
    const sync = syncWith("manual");
    const push = vi.spyOn(sync, "push").mockResolvedValue({ success: true, message: "Synced" });
    sync.onChatEnd();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("waits out a push already running, then pushes", async () => {
    vi.useFakeTimers();
    const sync = syncWith("after_chat");
    const push = vi.spyOn(sync, "push").mockResolvedValue({ success: true, message: "Synced" });
    (sync as unknown as { isSyncing: boolean }).isSyncing = true;
    sync.onChatEnd();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).not.toHaveBeenCalled();
    (sync as unknown as { isSyncing: boolean }).isSyncing = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
