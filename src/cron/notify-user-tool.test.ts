// notify_user: a scheduled run's in-app way to write to the user. Peter,
// 2026-11-08: a reminder mission messaged him on Telegram and the inbox only
// filed "Scheduled job ... finished" (kind job), so the phone alert he had on
// ("Your agent writes to you") never rang. The reminder itself must land as
// an agent-message item, and the mission tool must steer reminders to it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCronTools, NOTIFY_USER_GUIDANCE } from "./tools.js";
import { listInbox } from "../inbox/index.js";
import type { CronService } from "./cron-service.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.data.js";
import { AUDIENCES_BY_TOOL } from "../tools/audience-map.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-notify-user-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

const tools = createCronTools({} as CronService);
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe("notify_user", () => {
	it("files the reminder as 'Your agent writes to you', in its own words, pinned for the user", async () => {
		const res = await tool("notify_user").execute({ title: "Reminder: feed the cat.", message: "You asked at 12:37." });
		expect(res.isError).toBeFalsy();
		const items = listInbox().items;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: "agent-message", title: "Reminder: feed the cat.", body: "You asked at 12:37.", needsYou: true });
	});

	it("each reminder is its own item, so a repeat rings again", async () => {
		await tool("notify_user").execute({ title: "Reminder: feed the cat." });
		await tool("notify_user").execute({ title: "Reminder: feed the cat." });
		expect(listInbox().items).toHaveLength(2);
	});

	it("refuses an empty title and records nothing", async () => {
		const res = await tool("notify_user").execute({ title: "  " });
		expect(res.isError).toBe(true);
		expect(listInbox().items).toHaveLength(0);
	});

	it("reaches scheduled and background runs, and delivers only to the user", () => {
		expect(AUDIENCES_BY_TOOL.notify_user).toEqual(expect.arrayContaining(["operator", "spawned-agent"]));
		expect(TOOL_POLICIES.notify_user?.destination).toEqual([{ to: "user" }]);
	});

	it("mission_schedule_create tells the agent to send reminders with notify_user", () => {
		expect(tool("mission_schedule_create").description).toContain(NOTIFY_USER_GUIDANCE);
		expect(NOTIFY_USER_GUIDANCE).toMatch(/notify_user/);
		expect(NOTIFY_USER_GUIDANCE).toMatch(/telegram_send or whatsapp_send only when the user asked/);
	});
});
