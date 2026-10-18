// One-shot spend-budget notice: end-to-end over a TEMP LAX_DATA_DIR.
//
// Every test here points LAX_DATA_DIR at a throwaway directory before the
// modules under test resolve it (getLaxDir reads the env per call), so the
// developer's real ~/.lax config.json / migration-version.json / user-notices
// ledger / inbox.json are never read or written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir = "";
let realDataDir: string | undefined;

beforeEach(() => {
  realDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "lax-notice-"));
  process.env.LAX_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  if (realDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = realDataDir;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"));
}

/** A "boot": run migrations, then drain into the inbox. Returns the inbox's notices. */
async function boot(): Promise<{ delivered: string[]; notices: Array<{ title: string; kind: string }> }> {
  vi.resetModules();
  const { runMigrations } = await import("./db-migrations.js");
  await runMigrations(dataDir);
  const { drainUserNotices } = await import("./user-notice.js");
  const delivered = drainUserNotices();
  const { listInbox } = await import("./inbox/index.js");
  return { delivered, notices: listInbox().items.filter((i) => i.kind === "notice").map((i) => ({ title: i.title, kind: i.kind })) };
}

describe("spend-budget one-shot notice", () => {
  it("lands in the inbox exactly once for an install that had stored 0s, then never again", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });

    const first = await boot();
    expect(readConfig()).toMatchObject({ dailyBudgetUsd: 75, sessionBudgetUsd: 15 });
    expect(first.delivered).toEqual(["spend-budget-defaults"]);
    expect(first.notices).toEqual([{
      kind: "notice",
      title: "Spend caps are now on by default: $75/day and $15/session. On a subscription login the cost is shown but is never a real charge and never stops anything. Set either to 0 in Settings for no cap.",
    }]);

    // The delivered marker is on disk, not in memory.
    const ledger = JSON.parse(readFileSync(join(dataDir, "user-notices.json"), "utf-8"));
    expect(ledger.pending).toEqual([]);
    expect(ledger.delivered.map((d: { id: string }) => d.id)).toEqual(["spend-budget-defaults"]);

    // MUTATION TARGET: delete markUserNoticeDelivered's write and this goes red.
    const second = await boot();
    expect(second.delivered).toEqual([]);
    expect(second.notices).toHaveLength(1);
  });

  it("says nothing to an install that never had 0s", async () => {
    writeConfig({ dailyBudgetUsd: 20, sessionBudgetUsd: 5 });
    const { delivered, notices } = await boot();
    expect(delivered).toEqual([]);
    expect(notices).toEqual([]);
    expect(readConfig()).toMatchObject({ dailyBudgetUsd: 20, sessionBudgetUsd: 5 });
    expect(existsSync(join(dataDir, "user-notices.json"))).toBe(false);
  });

  it("needs no open screen: the inbox keeps it for whichever screen opens next", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
    const { broadcastAll } = await import("./chat-ws/broadcast.js");
    const { clients } = await import("./chat-ws/state.js");
    expect(clients.size).toBe(0);
    expect(broadcastAll({ type: "projects_changed" })).toBe(0); // nobody connected
    const { delivered } = await boot();
    expect(delivered).toEqual(["spend-budget-defaults"]);
    const { hasDeliveredUserNotice } = await import("./user-notice.js");
    expect(hasDeliveredUserNotice("spend-budget-defaults")).toBe(true);
  });

  it("stays pending when the inbox could not record it, and lands on a later boot", async () => {
    const { recordUserNotice, drainUserNotices, readPendingUserNotices } = await import("./user-notice.js");
    recordUserNotice("later", "hello");
    // An inbox.json that is a directory cannot be written: postToInbox returns null.
    mkdirSync(join(dataDir, "inbox.json"));
    expect(drainUserNotices()).toEqual([]);
    expect(readPendingUserNotices()).toHaveLength(1);
    rmSync(join(dataDir, "inbox.json"), { recursive: true, force: true });
    expect(drainUserNotices()).toEqual(["later"]);
    expect(readPendingUserNotices()).toEqual([]);
  });

  it("re-queues nothing when the migration marker is asked to record twice", async () => {
    const { recordUserNotice, readPendingUserNotices, drainUserNotices } = await import("./user-notice.js");
    recordUserNotice("dupe", "hello");
    recordUserNotice("dupe", "hello");
    expect(readPendingUserNotices()).toHaveLength(1);
    expect(drainUserNotices()).toEqual(["dupe"]);
    recordUserNotice("dupe", "hello");
    expect(readPendingUserNotices()).toEqual([]);
  });

  it("leaves no ledger and no inbox when nothing is pending", async () => {
    const { drainUserNotices } = await import("./user-notice.js");
    expect(drainUserNotices()).toEqual([]);
    expect(existsSync(join(dataDir, "user-notices.json"))).toBe(false);
    expect(existsSync(join(dataDir, "inbox.json"))).toBe(false);
  });

  it("does not touch the real ~/.lax", () => {
    // Guard against a future edit that resolves the dir at module load.
    expect(process.env.LAX_DATA_DIR).toBe(dataDir);
    expect(dataDir.includes(".lax")).toBe(false);
  });
});
