import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markRepairAttempted, readUpdateHealth, recordUpdateFailure, recordUpdateSuccess,
  repairStuckUpdateState, REPAIR_THRESHOLD,
} from "./update-recovery.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
function lax(): string { const d = mkdtempSync(join(tmpdir(), "lax-recovery-")); roots.push(d); return d; }

describe("update-recovery (local-only health + self-repair)", () => {
  it("counts consecutive failures and resets on success", () => {
    const d = lax();
    expect(readUpdateHealth(d).consecutiveFailures).toBe(0);
    expect(recordUpdateFailure(d, "boom").consecutiveFailures).toBe(1);
    expect(recordUpdateFailure(d, "boom again").consecutiveFailures).toBe(2);
    expect(readUpdateHealth(d).lastError).toBe("boom again");
    recordUpdateSuccess(d);
    expect(readUpdateHealth(d).consecutiveFailures).toBe(0);
    expect(readUpdateHealth(d).lastError).toBeUndefined();
  });

  it("repairStuckUpdateState clears ONLY the rollback + updates dirs, never config/history", () => {
    const d = lax();
    for (const rel of ["update-rollback", "updates"]) mkdirSync(join(d, rel), { recursive: true });
    writeFileSync(join(d, "config.json"), "{}");
    writeFileSync(join(d, "installed-source.json"), "{}");
    writeFileSync(join(d, "update-history.json"), "[]");
    const cleared = repairStuckUpdateState(d).sort();
    expect(cleared).toEqual(["update-rollback", "updates"]);
    expect(existsSync(join(d, "update-rollback"))).toBe(false);
    expect(existsSync(join(d, "updates"))).toBe(false);
    // untouched:
    expect(existsSync(join(d, "config.json"))).toBe(true);
    expect(existsSync(join(d, "installed-source.json"))).toBe(true);
    expect(existsSync(join(d, "update-history.json"))).toBe(true);
  });

  it("repair fires once per streak (repairAttempted latches)", () => {
    const d = lax();
    recordUpdateFailure(d, "1");
    const atThreshold = recordUpdateFailure(d, "2");
    expect(atThreshold.consecutiveFailures).toBe(REPAIR_THRESHOLD);
    expect(atThreshold.repairAttempted).toBe(false); // caller hasn't repaired yet
    markRepairAttempted(d);
    expect(readUpdateHealth(d).repairAttempted).toBe(true);
    // further failures keep counting but the flag stays latched until a success resets it
    expect(recordUpdateFailure(d, "3").repairAttempted).toBe(true);
    recordUpdateSuccess(d);
    expect(readUpdateHealth(d).repairAttempted).toBe(false);
  });

  it("tolerates corrupt/missing health file (never throws)", () => {
    const d = lax();
    writeFileSync(join(d, "update-health.json"), "{ not json");
    expect(readUpdateHealth(d)).toEqual({ consecutiveFailures: 0, repairAttempted: false });
    expect(repairStuckUpdateState(join(d, "does-not-exist"))).toEqual([]);
  });
});
