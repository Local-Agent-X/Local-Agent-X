// A one-time mission ends after its scheduled run (cron-service-execute.ts
// finishOneTime). Peter, 2026-11-08: a date reminder ("0 12 3 11 *") stayed
// set for every Nov 3 because the run had to find the off-switch itself. It is
// switched off and KEPT, never deleted: a one-time "semiconductor report before
// Monday's open" is a report he needs afterwards, and a delete would purge the
// history and report. A failed run waits for its retry first. A manual
// "Run now" ends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "./cron-service-execute.js";
import { DEFAULT_SETTINGS, type CronJob, type ExecuteHandler } from "./cron-service-types.js";
import type { CronService } from "./cron-service.js";
import { createCronTools, ONE_TIME_GUIDANCE } from "./tools.js";
import { inboxStore } from "../inbox/index.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-cron-once-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function service(handler: ExecuteHandler, retries = 0) {
	const deleted: string[] = [];
	const toggled: string[] = [];
	const svc = {
		executeHandler: handler,
		running: new Set<string>(),
		settings: { ...DEFAULT_SETTINGS, maxTransientRetries: retries, maxConsecutiveFailures: 0 },
		concurrencyDeferCount: new Map<string, number>(),
		transientRetryCount: new Map<string, number>(),
		timers: new Map(),
		history: { append: () => {} },
		saveJobs: () => {},
		changes: { raise: () => {} },
		executeJob: async () => {},
		delete: vi.fn(async (id: string) => { deleted.push(id); return true; }),
		toggle: vi.fn((id: string) => { toggled.push(id); return null; }),
	} as unknown as CronService;
	return { svc, deleted, toggled };
}

const mission = (over: Partial<CronJob> = {}): CronJob => ({
	id: "job-semis", name: "Semiconductor report before Monday's open", schedule: "0 8 10 11 *", prompt: "Gather the data and write the report",
	enabled: true, once: true, createdAt: new Date().toISOString(), ...over,
});

describe("one-time missions", () => {
	it("after its run it is switched off and kept, never deleted, and its notice opens the report", async () => {
		const { svc, deleted, toggled } = service(async () => ({ output: "Report ready.", status: "success" }));
		await runJob(svc, mission());
		expect(toggled).toEqual(["job-semis"]);
		expect(deleted).toEqual([]);
		const done = inboxStore().list().find((i) => i.kind === "job");
		expect(done?.link?.url).toBe("/api/cron/job-semis/reports/latest");
	});

	it("a failed run is switched off and kept too, so it never fires next year", async () => {
		const { svc, deleted, toggled } = service(async () => ({ output: "FAILED: no data", status: "failed", errorMessage: "no data" }));
		await runJob(svc, mission());
		expect(toggled).toEqual(["job-semis"]);
		expect(deleted).toEqual([]);
	});

	it("a run that threw waits for its retry instead of switching off", async () => {
		vi.useFakeTimers();
		try {
			const { svc, toggled } = service(async () => { throw new Error("provider unreachable"); }, 2);
			await runJob(svc, mission());
			expect(toggled).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a manual Run now ends nothing: the date has not come yet", async () => {
		const { svc, deleted, toggled } = service(async () => ({ output: "Report ready.", status: "success" }));
		await runJob(svc, mission(), { manual: true });
		expect(toggled).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("a recurring mission is never ended by its run", async () => {
		const { svc, deleted, toggled } = service(async () => ({ output: "News.", status: "success" }));
		await runJob(svc, mission({ once: undefined, schedule: "1h" }));
		expect(toggled).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("mission_schedule_create makes a one-time mission from `once`, and says so", async () => {
		const create = vi.fn((name: string, schedule: string, _prompt: string, _sys: unknown, opts: { tz?: string; once?: boolean }) =>
			({ id: "cron_x", name, schedule, prompt: "", enabled: true, createdAt: "", ...(opts.once ? { once: true } : {}) }));
		const cron = { list: () => [], create, get: () => null } as unknown as CronService;
		const tool = createCronTools(cron).find((t) => t.name === "mission_schedule_create")!;
		expect(tool.description).toContain(ONE_TIME_GUIDANCE);
		const res = await tool.execute({ name: "Semis report", schedule: "0 8 10 11 *", prompt: "Gather the data", once: true });
		expect(create.mock.calls[0][4]).toMatchObject({ once: true });
		expect(res.content).toContain("runs once at 0 8 10 11 *, then switches itself off");
	});
});
