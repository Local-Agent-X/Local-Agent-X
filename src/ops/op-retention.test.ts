// A finished upkeep run's record goes after a week. Everything the user asked
// for or reads back stays, whatever its age, and so does anything in flight.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OP_TYPE, UPKEEP_OP_TYPES } from "./op-types.js";
import type { Op } from "./types.js";

// op-store binds its folder from the data dir at import, so the override must
// be in place before the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-op-retention-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { pruneFinishedUpkeepOps, UPKEEP_OP_RETENTION_MS } = await import("./op-retention.js");
const { writeOp, readOp, OPS_BASE } = await import("./op-store.js");
const { opIdsWhere } = await import("./op-index.js");

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

function mkOp(id: string, type: string, status: Op["status"], finishedDaysAgo: number, extra: Partial<Op> = {}): Op {
  return {
    id, type, task: "t", contextPack: {} as Op["contextPack"],
    lane: "background" as Op["lane"], retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "u", visibility: "private" as Op["visibility"], status,
    createdAt: daysAgo(finishedDaysAgo), attemptCount: 0,
    ...(status === "running" ? {} : { completedAt: daysAgo(finishedDaysAgo) }),
    ...extra,
  };
}
const onDisk = (id: string): boolean => existsSync(join(OPS_BASE, id, "operation.json"));

describe("pruneFinishedUpkeepOps", () => {
  it("deletes upkeep runs that finished over a week ago, and nothing else", async () => {
    writeOp(mkOp("old_dream", OP_TYPE.memoryConsolidation, "completed", 30));
    writeOp(mkOp("old_skill", OP_TYPE.skillReview, "failed", 8));
    writeOp(mkOp("old_mail", OP_TYPE.mailWatch, "cancelled", 9));
    writeOp(mkOp("new_mail", OP_TYPE.mailWatch, "completed", 6));
    writeOp(mkOp("old_chat", OP_TYPE.chatTurn, "completed", 400));
    writeOp(mkOp("old_voice", OP_TYPE.voiceTurn, "completed", 400));
    writeOp(mkOp("old_cron", OP_TYPE.scheduledMission, "completed", 400));
    writeOp(mkOp("old_check", OP_TYPE.verifyDeliverable, "completed", 400));
    writeOp(mkOp("old_model_label", "anything_a_model_called_it", "completed", 400));

    expect(await pruneFinishedUpkeepOps(NOW)).toEqual({ pruned: 3, failed: 0 });

    expect(["old_dream", "old_skill", "old_mail"].filter(onDisk)).toEqual([]);
    expect(["new_mail", "old_chat", "old_voice", "old_cron", "old_check", "old_model_label"].filter((id) => !onDisk(id))).toEqual([]);
    expect(readOp("old_chat")?.type).toBe(OP_TYPE.chatTurn);
    // The index forgets what was deleted, so no later question returns it.
    expect(opIdsWhere((f) => UPKEEP_OP_TYPES.has(f.type))).toEqual(["new_mail"]);
    // Nothing left to do on the next pass.
    expect(await pruneFinishedUpkeepOps(NOW)).toEqual({ pruned: 0, failed: 0 });
  });

  it("never deletes a run still in flight, however old", async () => {
    writeOp(mkOp("stuck_dream", OP_TYPE.memoryConsolidation, "running", 60));
    // Finished by its status, but its canonical run has not ended: it can still move.
    writeOp(mkOp("ending_review", OP_TYPE.failureReview, "completed", 60, {
      canonical: { flagValue: true, state: "running", sessionId: "s" } as unknown as Op["canonical"],
    }));
    expect(await pruneFinishedUpkeepOps(NOW)).toEqual({ pruned: 0, failed: 0 });
    expect(onDisk("stuck_dream") && onDisk("ending_review")).toBe(true);
  });

  it("keeps a run whose dates cannot be read", async () => {
    writeOp(mkOp("undated", OP_TYPE.travelWatch, "completed", 60, { createdAt: "not a date", completedAt: undefined }));
    expect(await pruneFinishedUpkeepOps(NOW)).toEqual({ pruned: 0, failed: 0 });
    expect(onDisk("undated")).toBe(true);
  });

  it("the default age is a week", async () => {
    expect(UPKEEP_OP_RETENTION_MS).toBe(7 * DAY);
    writeOp(mkOp("six_days", OP_TYPE.skillReview, "completed", 6.9));
    writeOp(mkOp("eight_days", OP_TYPE.skillReview, "completed", 7.1));
    expect(await pruneFinishedUpkeepOps(NOW)).toEqual({ pruned: 1, failed: 0 });
    expect(onDisk("six_days")).toBe(true);
    expect(onDisk("eight_days")).toBe(false);
  });
});

describe("the upkeep types", () => {
  it("are the app's own background jobs, never a run the user asked for or reads back", () => {
    expect([...UPKEEP_OP_TYPES].sort()).toEqual([
      OP_TYPE.failureReview, OP_TYPE.mailWatch, OP_TYPE.memoryConsolidation, OP_TYPE.skillReview, OP_TYPE.travelWatch,
    ].sort());
  });
});
