// A date schedule's next run can be a year away. It used to be found within
// 48h or answered "24h from now", so a reminder for one afternoon ran again
// every day (2026-10-24); and a delay that long is past what one setTimeout can
// wait (it fires at once beyond ~24.8 days), so the service waits in steps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService, MAX_TIMER_WAIT_MS } from "./cron-service.js";

let dataDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  // Two days after the date, so no catch-up run is due at start.
  vi.setSystemTime(new Date("2026-10-26T17:00:00Z"));
  dataDir = mkdtempSync(join(tmpdir(), "cron-schedule-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a date schedule whose day has passed", () => {
  it("waits for that date next year, in steps no timer overflows, and runs once", async () => {
    const cron = new CronService(dataDir);
    const job = cron.create("feed-dog-reminder", "0 14 24 10 *", "Send the reminder.", false, { tz: "America/Chicago" });
    const runs = vi.spyOn(cron, "executeJob").mockResolvedValue();
    cron.start();
    expect(cron.getNextRunAt(job)).toBe("2027-10-24T19:00:00.000Z");

    await vi.advanceTimersByTimeAsync(24 * 3600_000 + 60_000);
    expect(runs).not.toHaveBeenCalled(); // the old daily fallback ran it here
    await vi.advanceTimersByTimeAsync(MAX_TIMER_WAIT_MS + 6 * 24 * 3600_000);
    expect(runs).not.toHaveBeenCalled(); // an overflowing setTimeout would have fired by now

    await vi.advanceTimersByTimeAsync(new Date("2027-10-24T19:00:30Z").getTime() - Date.now());
    expect(runs).toHaveBeenCalledTimes(1);
    cron.stop();
  });
});
