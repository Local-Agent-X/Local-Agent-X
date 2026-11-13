// Agent Sync's three buttons (Sync now, Force pull, Force push) for a paired phone,
// so the user can sync this computer with the repo it is already set up for while
// away from it (agentxos MEMORY_SYNC_*_PATH, through the device http tunnel:
// broker-transport/device-paths.ts).
//
// The phone runs only the sync this desktop was set up for. It cannot turn sync on,
// change the repo or token, or see either: /api/sync/configure and /api/sync/status
// stay off the tunnel, and the status here names no repo. A git sync can outlast a
// tunnel request, so an action answers at once with "syncing" and runs on; the phone
// reads the status until it settles. The agent cannot reach these routes: they sit
// under /api/sync, which rbac-agent-denials.ts refuses it.

import type { MemorySyncStatus } from "../broker-transport/vendor/memory-sync.js";
import { createLogger } from "../logger.js";

const logger = createLogger("sync.device");

type SyncResult = { success: boolean; message: string };

/** The part of AgentSync this drives. */
export interface DeviceSyncTarget {
  getStatus(): { enabled: boolean; repoUrl: string; isSyncing: boolean; lastSync: number };
  push(): Promise<SyncResult>;
  pull(): Promise<SyncResult>;
}

export type DeviceSyncAction = "sync" | "pull" | "push";

export interface DeviceSync {
  status(): MemorySyncStatus;
  /** Start the action in the background; the status as of now. */
  run(action: DeviceSyncAction): MemorySyncStatus;
  /** Settles when the action in flight (if any) does; for tests. */
  settled(): Promise<void>;
}

const LABEL: Record<DeviceSyncAction, string> = { sync: "Sync now", pull: "Force pull", push: "Force push" };

/** Sync now sends this computer's changes, which also merges the other computers'
 *  into the sync repo, then copies the merged result here. */
async function perform(target: DeviceSyncTarget, action: DeviceSyncAction): Promise<SyncResult> {
  if (action === "pull") return target.pull();
  const pushed = await target.push();
  if (action === "push" || !pushed.success) return pushed;
  return target.pull();
}

export function createDeviceSync(target: DeviceSyncTarget): DeviceSync {
  let running: Promise<void> | null = null;
  let last: { ok: boolean; message: string } | null = null;

  function status(): MemorySyncStatus {
    const s = target.getStatus();
    const lastSync = s.lastSync > 0 ? s.lastSync : null;
    if (!s.enabled || !s.repoUrl) {
      return { state: "off", lastSync, message: "Sync is not set up on this computer. Turn it on in Settings → Sync there." };
    }
    if (running || s.isSyncing) return { state: "syncing", lastSync };
    if (last && !last.ok) return { state: "failed", lastSync, message: last.message };
    return { state: "idle", lastSync, ...(last ? { message: last.message } : {}) };
  }

  function run(action: DeviceSyncAction): MemorySyncStatus {
    const now = status();
    if (now.state === "off" || now.state === "syncing") return now;
    last = null;
    running = perform(target, action)
      .then((r) => { last = { ok: r.success, message: r.message }; })
      .catch((e: unknown) => { last = { ok: false, message: (e as Error).message }; })
      .finally(() => {
        running = null;
        logger.info(`[device-sync] ${LABEL[action]} from the phone: ${last?.ok ? "ok" : "failed"} — ${last?.message ?? ""}`);
      });
    return status();
  }

  return { status, run, settled: async () => { await running; } };
}
