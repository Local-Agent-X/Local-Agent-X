import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService } from "../src/cron/cron-service.js";

let dataDir: string;
let cron: CronService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-svc-"));
  cron = new CronService(dataDir);
  // Disable auto-scheduling so create() / toggle() don't spin up real timers.
  cron.updateSettings({ enabled: false });
});

afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CronService — list / toggle / delete / nextRunAt", () => {
  it("list() returns created jobs and persists them across instances", () => {
    const job = cron.create("daily-report", "1h", "do the thing");
    const all = cron.list();
    expect(all.map(j => j.id)).toContain(job.id);
    expect(all.find(j => j.id === job.id)?.enabled).toBe(true);

    // New instance reading the same dataDir should see the persisted job.
    const cron2 = new CronService(dataDir);
    expect(cron2.list().find(j => j.id === job.id)?.name).toBe("daily-report");
  });

  it("toggle() flips enabled and clears consecutive failure streak on resume", () => {
    const job = cron.create("temp", "1h", "x");
    // Simulate a failure streak then pause.
    job.consecutiveFailures = 3;
    cron.update(job.id, { consecutiveFailures: 3 });
    const paused = cron.toggle(job.id);
    expect(paused?.enabled).toBe(false);
    const resumed = cron.toggle(job.id);
    expect(resumed?.enabled).toBe(true);
    expect(resumed?.consecutiveFailures).toBe(0);
  });

  it("delete() removes the job and purges history", () => {
    const job = cron.create("doomed", "1h", "x");
    expect(cron.delete(job.id)).toBe(true);
    expect(cron.get(job.id)).toBeNull();
    expect(cron.list().some(j => j.id === job.id)).toBe(false);
    // Idempotent: second delete returns false.
    expect(cron.delete(job.id)).toBe(false);
  });

  it("getNextRunAt() returns null when settings disabled or job paused", () => {
    const job = cron.create("paused-soon", "1h", "x");
    // Settings.enabled is false in beforeEach, so even an active job has no next run.
    expect(cron.getNextRunAt(job)).toBeNull();
    cron.updateSettings({ enabled: true });
    cron.stop(); // updateSettings re-armed timers — kill them so the test is clean.
    const next = cron.getNextRunAt(job);
    expect(next).not.toBeNull();
    // Pausing the job clears next run.
    const paused = cron.toggle(job.id)!;
    cron.stop();
    expect(cron.getNextRunAt(paused)).toBeNull();
  });
});

describe("CronService — manual run records history and updates lastRun", () => {
  it("executeJob({manual:true}) calls the handler, updates lastStatus, and writes one history row", async () => {
    const calls: Array<{ jobId: string; manual: boolean }> = [];
    cron.onExecute(async (jobId, _prompt, ctx) => {
      calls.push({ jobId, manual: ctx.manual });
      return "done";
    });
    const job = cron.create("manual-run", "1h", "x");

    await cron.executeJob(job, { manual: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].manual).toBe(true);
    const fresh = cron.get(job.id)!;
    expect(fresh.lastRun).toBeTruthy();
    expect(fresh.lastStatus).toBe("success");
    expect(fresh.consecutiveFailures).toBe(0);

    const runs = cron.listHistory(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].manual).toBe(true);
    expect(runs[0].status).toBe("success");
  });

  it("a thrown handler error records an error row with the message", async () => {
    cron.onExecute(async () => { throw new Error("boom"); });
    const job = cron.create("crashy", "1h", "x");

    await cron.executeJob(job, { manual: true });

    const fresh = cron.get(job.id)!;
    expect(fresh.lastStatus).toBe("error");
    expect(fresh.lastErrorMessage).toBe("boom");
    expect(fresh.consecutiveFailures).toBe(1);
    const runs = cron.listHistory(job.id);
    expect(runs[0].status).toBe("error");
    expect(runs[0].errorMessage).toBe("boom");
  });

  it("create() persists the job to jobs.json on disk", () => {
    const job = cron.create("persisted", "1h", "x");
    const file = join(dataDir, "cron", "jobs.json");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; name: string }>;
    expect(onDisk.some(j => j.id === job.id && j.name === "persisted")).toBe(true);
  });
});

describe("CronService — clearLastError", () => {
  it("clears sticky error message, demotes failed/error status, resets streak", async () => {
    cron.onExecute(async () => { throw new Error("boom"); });
    const job = cron.create("flaky", "1h", "x");
    await cron.executeJob(job, { manual: true });
    const after = cron.get(job.id)!;
    expect(after.lastErrorMessage).toBe("boom");
    expect(after.lastStatus).toBe("error");
    expect(after.consecutiveFailures).toBe(1);

    expect(cron.clearLastError(job.id)).toBe(true);

    const cleared = cron.get(job.id)!;
    expect(cleared.lastErrorMessage).toBeUndefined();
    expect(cleared.lastStatus).toBeUndefined();
    expect(cleared.consecutiveFailures).toBe(0);
  });

  it("does not overwrite a successful status badge", () => {
    const job = cron.create("good", "1h", "x");
    cron.update(job.id, { lastStatus: "success", lastErrorMessage: undefined });
    cron.clearLastError(job.id);
    expect(cron.get(job.id)?.lastStatus).toBe("success");
  });

  it("returns false for an unknown job id", () => {
    expect(cron.clearLastError("nope_does_not_exist")).toBe(false);
  });

  it("persists the cleared state to disk", async () => {
    cron.onExecute(async () => { throw new Error("boom"); });
    const job = cron.create("persist-clear", "1h", "x");
    await cron.executeJob(job, { manual: true });
    cron.clearLastError(job.id);
    const file = join(dataDir, "cron", "jobs.json");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; lastErrorMessage?: string; consecutiveFailures?: number }>;
    const row = onDisk.find(j => j.id === job.id)!;
    expect(row.lastErrorMessage).toBeUndefined();
    expect(row.consecutiveFailures).toBe(0);
  });
});

describe("CronService — cancelRun / abort registry", () => {
  it("cancelRun() returns false when no run is in flight", () => {
    const job = cron.create("idle", "1h", "x");
    expect(cron.cancelRun(job.id)).toBe(false);
  });

  it("cancelRun() aborts a registered controller and returns true", () => {
    const job = cron.create("midflight", "1h", "x");
    const ctrl = new AbortController();
    cron.registerRunAbort(job.id, ctrl);
    expect(ctrl.signal.aborted).toBe(false);
    expect(cron.cancelRun(job.id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("unregisterRunAbort() prevents future cancellation", () => {
    const job = cron.create("clean", "1h", "x");
    const ctrl = new AbortController();
    cron.registerRunAbort(job.id, ctrl);
    cron.unregisterRunAbort(job.id);
    expect(cron.cancelRun(job.id)).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });
});
