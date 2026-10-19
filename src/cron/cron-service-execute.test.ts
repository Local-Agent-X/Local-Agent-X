// A scheduled run's outcome reaches the user's inbox: a failure needs them
// (one item per job, refreshed by further failures), a finished run is
// information. The executor posts it because only it knows the verdict after
// the report quality gate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "./cron-service-execute.js";
import { DEFAULT_SETTINGS, type CronJob, type ExecuteHandler } from "./cron-service-types.js";
import type { CronService } from "./cron-service.js";
import { inboxStore } from "../inbox/index.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-cron-inbox-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function service(handler: ExecuteHandler): CronService {
  return {
    executeHandler: handler,
    running: new Set<string>(),
    settings: { ...DEFAULT_SETTINGS, maxTransientRetries: 0, maxConsecutiveFailures: 0 },
    concurrencyDeferCount: new Map<string, number>(),
    transientRetryCount: new Map<string, number>(),
    timers: new Map(),
    history: { append: () => {} },
    saveJobs: () => {},
    changes: { raise: () => {} },
    executeJob: async () => {},
  } as unknown as CronService;
}

const job = (): CronJob => ({ id: "job-news", name: "Morning news", schedule: "1h", prompt: "summarize the news", enabled: true, createdAt: new Date().toISOString() });
const jobs = () => inboxStore().list().filter((i) => i.kind === "job");

describe("cron outcomes in the inbox", () => {
  it("a failed run posts one needs-you item naming the job and the reason, linked to the run's transcript", async () => {
    const j = job();
    await runJob(service(async () => ({ output: "FAILED: off-topic report", status: "failed", errorMessage: "off-topic report", sessionId: "cron-job-news-1" })), j);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ title: 'Scheduled job "Morning news" failed', body: "off-topic report", needsYou: true, link: { sessionId: "cron-job-news-1" } });
  });

  it("a second failure refreshes the same needs-you item instead of adding another", async () => {
    const j = job();
    await runJob(service(async () => ({ output: "FAILED: a", status: "failed", errorMessage: "first reason" })), j);
    await runJob(service(async () => ({ output: "FAILED: b", status: "failed", errorMessage: "second reason" })), j);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].body).toBe("second reason");
  });

  it("a run that throws is a failure too", async () => {
    await runJob(service(async () => { throw new Error("provider unreachable"); }), job());
    expect(jobs()[0]).toMatchObject({ needsYou: true, body: "provider unreachable" });
  });

  it("a successful run is information, and does not clear the failure the user has not seen to", async () => {
    const j = job();
    await runJob(service(async () => ({ output: "FAILED: x", status: "failed", errorMessage: "x" })), j);
    await runJob(service(async () => ({ output: "Top stories: ...", status: "success" })), j);
    const items = jobs();
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.needsYou)?.title).toBe('Scheduled job "Morning news" failed');
    // The finished item opens the job's latest report; the failure offers no link.
    expect(items.find((i) => !i.needsYou)).toMatchObject({ title: 'Scheduled job "Morning news" finished', body: "Top stories: ...", link: { url: "/api/cron/job-news/reports/latest" } });
    expect(items.find((i) => i.needsYou)?.link?.url).toBeUndefined();
  });
});
