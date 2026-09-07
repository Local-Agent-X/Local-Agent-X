// One-shot spend-budget notice: end-to-end over a TEMP LAX_DATA_DIR.
//
// Every test here points LAX_DATA_DIR at a throwaway directory before the
// modules under test resolve it (getLaxDir reads the env per call), so the
// developer's real ~/.lax config.json / migration-version.json / user-notices
// ledger are never read or written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

/** A "boot": run migrations, then drain post-bind against a fake client count. */
async function boot(openClients: number): Promise<Record<string, unknown>[]> {
  vi.resetModules();
  const { runMigrations } = await import("./db-migrations.js");
  await runMigrations(dataDir);
  const { startUserNoticeDrain } = await import("./user-notice.js");
  const seen: Record<string, unknown>[] = [];
  startUserNoticeDrain((data) => { seen.push(data); return openClients; }, { intervalMs: 5, maxWaitMs: 20 });
  return seen;
}

describe("spend-budget one-shot notice", () => {
  it("delivers exactly once for an install that had stored 0s, then never again", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });

    const first = await boot(1);
    expect(readConfig()).toMatchObject({ dailyBudgetUsd: 75, sessionBudgetUsd: 15 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "user_notice", noticeId: "spend-budget-defaults" });
    expect(first[0].text).toBe(
      "Spend caps are now on by default: $75/day and $15/session. On a subscription login the cost is shown but is never a real charge and never stops anything. Set either to 0 in Settings for no cap.",
    );

    // The delivered marker is on disk, not in memory.
    const ledger = JSON.parse(readFileSync(join(dataDir, "user-notices.json"), "utf-8"));
    expect(ledger.pending).toEqual([]);
    expect(ledger.delivered.map((d: { id: string }) => d.id)).toEqual(["spend-budget-defaults"]);

    // MUTATION TARGET: delete markUserNoticeDelivered's write and this goes red.
    const second = await boot(1);
    expect(second).toEqual([]);
  });

  it("says nothing to an install that never had 0s", async () => {
    writeConfig({ dailyBudgetUsd: 20, sessionBudgetUsd: 5 });
    const seen = await boot(1);
    expect(seen).toEqual([]);
    expect(readConfig()).toMatchObject({ dailyBudgetUsd: 20, sessionBudgetUsd: 5 });
    expect(existsSync(join(dataDir, "user-notices.json"))).toBe(false);
  });

  it("stays pending when no UI client is connected, and lands on a later boot", async () => {
    writeConfig({ dailyBudgetUsd: 0, sessionBudgetUsd: 0 });

    // Boot 1: migration runs, notice queued, but zero open clients.
    const headless = await boot(0);
    expect(headless).toHaveLength(1); // attempted...
    const { readPendingUserNotices, hasDeliveredUserNotice } = await import("./user-notice.js");
    expect(readPendingUserNotices()).toHaveLength(1); // ...but not marked delivered
    expect(hasDeliveredUserNotice("spend-budget-defaults")).toBe(false);

    // Boot 2 with a client: the migration is done (version ledger), yet the
    // notice still gets shown — durability is the file, not an in-memory flag.
    const withClient = await boot(1);
    expect(withClient).toHaveLength(1);
    expect(withClient[0]).toMatchObject({ noticeId: "spend-budget-defaults" });

    // Boot 3: silent.
    expect(await boot(1)).toEqual([]);
  });

  it("re-queues nothing when the migration marker is asked to record twice", async () => {
    const { recordUserNotice, readPendingUserNotices, drainUserNotices } = await import("./user-notice.js");
    recordUserNotice("dupe", "hello");
    recordUserNotice("dupe", "hello");
    expect(readPendingUserNotices()).toHaveLength(1);
    expect(drainUserNotices(() => 1)).toEqual(["dupe"]);
    recordUserNotice("dupe", "hello");
    expect(readPendingUserNotices()).toEqual([]);
  });

  it("starts no timer and leaves no ledger when nothing is pending", async () => {
    const { startUserNoticeDrain } = await import("./user-notice.js");
    const broadcast = vi.fn(() => 1);
    startUserNoticeDrain(broadcast);
    expect(broadcast).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "user-notices.json"))).toBe(false);
  });

  it("does not touch the real ~/.lax", () => {
    // Guard against a future edit that resolves the dir at module load.
    expect(process.env.LAX_DATA_DIR).toBe(dataDir);
    expect(dataDir.includes(".lax")).toBe(false);
  });
});

describe("user_notice delivery path", () => {
  it("rides the real broadcastAll to every open client, verbatim", async () => {
    // The notice is a top-level chat-ws message, NOT a session ServerEvent, so
    // the process relay's SESSION_EVENT_TYPES allowlist is not in its path at
    // all — same class as `system_health`. This asserts against the REAL
    // broadcastAll and the REAL clients map, not a mock socket layer.
    const { broadcastAll } = await import("./chat-ws/broadcast.js");
    const { clients } = await import("./chat-ws/state.js");
    const sent: string[] = [];
    const ws = { readyState: 1, send: (p: string) => sent.push(p) };
    clients.set(ws as never, new Set<string>());
    try {
      const { drainUserNotices, recordUserNotice, SPEND_BUDGET_NOTICE_ID, SPEND_BUDGET_NOTICE_TEXT } =
        await import("./user-notice.js");
      recordUserNotice(SPEND_BUDGET_NOTICE_ID, SPEND_BUDGET_NOTICE_TEXT);
      expect(drainUserNotices(broadcastAll)).toEqual([SPEND_BUDGET_NOTICE_ID]);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0])).toEqual({
        type: "user_notice",
        noticeId: SPEND_BUDGET_NOTICE_ID,
        text: SPEND_BUDGET_NOTICE_TEXT,
      });
    } finally {
      clients.delete(ws as never);
    }
  });

  it("keeps the notice pending when broadcastAll reaches nobody", async () => {
    const { broadcastAll } = await import("./chat-ws/broadcast.js");
    const { drainUserNotices, recordUserNotice, readPendingUserNotices } = await import("./user-notice.js");
    recordUserNotice("lonely", "nobody home");
    expect(drainUserNotices(broadcastAll)).toEqual([]);
    expect(readPendingUserNotices()).toHaveLength(1);
  });
});
