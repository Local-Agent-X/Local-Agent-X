// Agent Sync's buttons as a paired phone presses them (device-sync.ts): each runs
// in the background and the status says where it stands; the phone reaches these
// routes and no other sync route; the agent reaches none of them.
import { describe, expect, it } from "vitest";
import { createDeviceSync, type DeviceSyncTarget } from "./device-sync.js";
import { isDeviceAllowedPath } from "../broker-transport/device-paths.js";
import { agentDeniedRouteFor } from "../rbac-agent-denials.js";
import {
  MEMORY_SYNC_PATH, MEMORY_SYNC_PULL_PATH, MEMORY_SYNC_PUSH_PATH, MEMORY_SYNC_RUN_PATH, parseMemorySyncStatus,
} from "../broker-transport/vendor/memory-sync.js";

type Result = { success: boolean; message: string };

function fakeSync(over: Partial<{ enabled: boolean; repoUrl: string; isSyncing: boolean; push: Result; pull: Result }> = {}) {
  const calls: string[] = [];
  const state = { enabled: true, repoUrl: "https://github.com/me/lax-sync.git", isSyncing: false, lastSync: 0, ...over };
  const target: DeviceSyncTarget = {
    getStatus: () => ({ enabled: state.enabled, repoUrl: state.repoUrl, isSyncing: state.isSyncing, lastSync: state.lastSync }),
    push: async () => { calls.push("push"); const r = over.push ?? { success: true, message: "Synced" }; if (r.success) state.lastSync = 1731400000000; return r; },
    pull: async () => { calls.push("pull"); return over.pull ?? { success: true, message: "Downloaded latest." }; },
  };
  return { target, calls, state };
}

describe("the phone's sync buttons", () => {
  it("Sync now pushes, then pulls; it answers syncing at once and settles idle with what the pull did", async () => {
    const { target, calls } = fakeSync();
    const sync = createDeviceSync(target);
    expect(sync.status()).toEqual({ state: "idle", lastSync: null });
    expect(sync.run("sync").state).toBe("syncing");
    await sync.settled();
    expect(calls).toEqual(["push", "pull"]);
    expect(sync.status()).toEqual({ state: "idle", lastSync: 1731400000000, message: "Downloaded latest." });
  });

  it("Force pull only pulls; Force push only pushes", async () => {
    const a = fakeSync();
    const pull = createDeviceSync(a.target);
    pull.run("pull");
    await pull.settled();
    expect(a.calls).toEqual(["pull"]);
    const b = fakeSync();
    const push = createDeviceSync(b.target);
    push.run("push");
    await push.settled();
    expect(b.calls).toEqual(["push"]);
    expect(push.status().message).toBe("Synced");
  });

  it("a failed push stops Sync now before the pull and reads failed with the reason", async () => {
    const { target, calls } = fakeSync({ push: { success: false, message: "Sync token missing from vault" } });
    const sync = createDeviceSync(target);
    sync.run("sync");
    await sync.settled();
    expect(calls).toEqual(["push"]);
    expect(sync.status()).toEqual({ state: "failed", lastSync: null, message: "Sync token missing from vault" });
  });

  it("starts nothing while a sync runs (its own or the desktop's) or when sync is not set up", async () => {
    const busy = fakeSync({ isSyncing: true });
    expect(createDeviceSync(busy.target).run("push").state).toBe("syncing");
    expect(busy.calls).toEqual([]);

    const off = fakeSync({ enabled: false });
    expect(createDeviceSync(off.target).run("sync")).toMatchObject({ state: "off" });
    const noRepo = fakeSync({ repoUrl: "" });
    expect(createDeviceSync(noRepo.target).run("pull").state).toBe("off");
    expect([...off.calls, ...noRepo.calls]).toEqual([]);

    const one = fakeSync();
    const sync = createDeviceSync(one.target);
    sync.run("sync");
    expect(sync.run("push").state).toBe("syncing");
    await sync.settled();
    expect(one.calls).toEqual(["push", "pull"]);
  });

  it("the status names no repo and parses as the phone reads it", () => {
    const status = createDeviceSync(fakeSync().target).status();
    expect(JSON.stringify(status)).not.toContain("github.com");
    expect(parseMemorySyncStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });
});

describe("who reaches the sync routes", () => {
  it("the phone reaches the device paths and no other sync route", () => {
    for (const p of [MEMORY_SYNC_PATH, MEMORY_SYNC_RUN_PATH, MEMORY_SYNC_PULL_PATH, MEMORY_SYNC_PUSH_PATH]) expect(isDeviceAllowedPath(p), p).toBe(true);
    for (const p of ["/api/sync/configure", "/api/sync/status", "/api/sync/push", "/api/sync/pull"]) expect(isDeviceAllowedPath(p), p).toBe(false);
  });

  it("the agent reaches none of them", () => {
    for (const p of [MEMORY_SYNC_PATH, MEMORY_SYNC_RUN_PATH, MEMORY_SYNC_PULL_PATH, MEMORY_SYNC_PUSH_PATH]) {
      expect(agentDeniedRouteFor(p)?.prefix, p).toBe("/api/sync");
    }
  });
});
