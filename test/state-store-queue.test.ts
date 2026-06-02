import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";

// state-store delegates file locations to paths.ts, which snaps APPS_DIR at
// module-load via getLaxDir(). We can't relocate that captured root per-test,
// so instead we drive everything through the module's OWN appDir()/statePath()
// helpers: create exactly the directory appDir(id) returns, seed a fresh
// state.json there, and clean that subtree afterward. This keeps the test
// hermetic regardless of which LAX_DATA_DIR was captured at import time.
import {
  queueAction,
  consumeActions,
  getPendingActions,
  writeState,
} from "../src/app-runtime/state-store.js";
import { appDir, statePath } from "../src/app-runtime/paths.js";
import { MAX_ACTIONS_QUEUED } from "../src/app-runtime/types.js";
import type { AppState, AuditEntry } from "../src/app-runtime/types.js";

const APP_ID = `state-store-queue-test-${process.pid}`;

// No-op audit writer matching the AuditWriter signature used by state-store.
const noopAudit = (appId: string, actor: string, action: string, details?: Record<string, unknown>): AuditEntry => ({
  id: "audit_test",
  timestamp: 0,
  actor,
  action,
  appId,
  details: details ?? {},
  prevHash: "genesis",
  signature: "test",
});

function freshState(): AppState {
  return {
    componentValues: {},
    actionQueue: [],
    metadata: { lastAgentUpdate: 0, lastUserUpdate: 0, version: 0 },
  };
}

let createdDir: string;

beforeEach(() => {
  // Create exactly the dir the module will write to, plus a parent tmp anchor
  // for cleanup. writeState() requires existsSync(appDir(id)) to be true.
  createdDir = appDir(APP_ID);
  mkdirSync(createdDir, { recursive: true });
  // Seed a known-empty state so readState() succeeds.
  writeState(APP_ID, freshState());
});

afterEach(() => {
  try { rmSync(createdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("queueAction overflow", () => {
  it("keeps only the newest MAX_ACTIONS_QUEUED actions, dropping the oldest", () => {
    const total = MAX_ACTIONS_QUEUED + 5;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const r = queueAction(APP_ID, "click", `target-${i}`, i, "agent", noopAudit);
      expect(r.error).toBeUndefined();
      expect(r.action).toBeDefined();
      ids.push(r.action!.id);
    }

    const pending = getPendingActions(APP_ID);
    // Queue is capped at MAX_ACTIONS_QUEUED.
    expect(pending.length).toBe(MAX_ACTIONS_QUEUED);

    // The 5 oldest were dropped; the surviving window is the last
    // MAX_ACTIONS_QUEUED actions, in insertion order.
    const expectedValues = Array.from({ length: MAX_ACTIONS_QUEUED }, (_, k) => k + (total - MAX_ACTIONS_QUEUED));
    expect(pending.map(a => a.value)).toEqual(expectedValues);

    // Exact surviving ids = last MAX_ACTIONS_QUEUED queued ids.
    const survivingIds = pending.map(a => a.id);
    expect(survivingIds).toEqual(ids.slice(-MAX_ACTIONS_QUEUED));

    // The dropped (oldest) ids must NOT be present.
    const droppedIds = ids.slice(0, total - MAX_ACTIONS_QUEUED);
    for (const dropped of droppedIds) {
      expect(survivingIds).not.toContain(dropped);
    }
  });

  it("does not drop anything when at or below the cap", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIONS_QUEUED; i++) {
      const r = queueAction(APP_ID, "click", `t-${i}`, i, "agent", noopAudit);
      ids.push(r.action!.id);
    }
    const pending = getPendingActions(APP_ID);
    expect(pending.length).toBe(MAX_ACTIONS_QUEUED);
    expect(pending.map(a => a.id)).toEqual(ids);
  });

  it("returns 'App not found' when state does not exist", () => {
    rmSync(createdDir, { recursive: true, force: true });
    const r = queueAction(APP_ID, "click", "t", 1, "agent", noopAudit);
    expect(r.error).toBe("App not found");
    expect(r.action).toBeUndefined();
  });
});

describe("consumeActions + getPendingActions", () => {
  it("marks only the consumed ids; getPendingActions returns the rest", () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = queueAction(APP_ID, "click", `t-${i}`, i, "agent", noopAudit);
      ids.push(r.action!.id);
    }

    // Consume a non-contiguous subset (indices 1, 3, 4).
    const consumed = [ids[1], ids[3], ids[4]];
    consumeActions(APP_ID, consumed);

    const pending = getPendingActions(APP_ID);
    const pendingIds = pending.map(a => a.id);

    // Survivors are exactly the un-consumed ones, in original order.
    expect(pendingIds).toEqual([ids[0], ids[2], ids[5]]);

    // None of the consumed ids leak into pending.
    for (const c of consumed) expect(pendingIds).not.toContain(c);
    // Every pending action is unconsumed.
    expect(pending.every(a => a.consumed === false)).toBe(true);
  });

  it("consuming an unknown id marks nothing", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(queueAction(APP_ID, "click", `t-${i}`, i, "agent", noopAudit).action!.id);
    }
    consumeActions(APP_ID, ["act_does_not_exist"]);
    const pending = getPendingActions(APP_ID);
    expect(pending.map(a => a.id)).toEqual(ids);
  });

  it("is idempotent — consuming the same id twice keeps it consumed", () => {
    const id = queueAction(APP_ID, "click", "t", 0, "agent", noopAudit).action!.id;
    consumeActions(APP_ID, [id]);
    consumeActions(APP_ID, [id]);
    expect(getPendingActions(APP_ID)).toEqual([]);
  });

  it("consuming all pending leaves an empty pending set", () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(queueAction(APP_ID, "click", `t-${i}`, i, "agent", noopAudit).action!.id);
    }
    consumeActions(APP_ID, ids);
    expect(getPendingActions(APP_ID)).toEqual([]);
  });

  it("getPendingActions returns [] for a missing app", () => {
    expect(getPendingActions("no-such-app-xyz")).toEqual([]);
    // statePath should not exist for a bogus id; sanity-check helper wiring.
    expect(statePath("no-such-app-xyz")).toContain("no-such-app-xyz");
  });
});
