import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService } from "./cron-service.js";
import { createCronTools } from "./tools.js";
import { broadcastMissionChanges, MISSIONS_CHANGED_FRAME } from "./mission-changes.js";

// A mission changed by any caller — the agent's mission_schedule_* tools,
// firing a heartbeat agent, its own run — reaches every open tab the way a
// route's change does, and one change is one frame.

let dataDir = "";
let cron: CronService;
const broadcastAll = vi.fn();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mission-changes-"));
  cron = new CronService(dataDir);
  cron.updateSettings({ enabled: false });
  broadcastMissionChanges(cron, broadcastAll);
  broadcastAll.mockClear();
});
afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const tool = (name: string) => createCronTools(cron).find((t) => t.name === name)!;
const frames = () => broadcastAll.mock.calls.length;
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("the agent's mission tools reach every tab", () => {
  it("create, update, toggle and delete each send one frame", async () => {
    await tool("mission_schedule_create").execute({ name: "n", schedule: "1h", prompt: "p" });
    await settle();
    expect(frames()).toBe(1);
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED_FRAME);
    const id = cron.list()[0].id;
    await tool("mission_schedule_update").execute({ id, prompt: "q" });
    await settle();
    expect(frames()).toBe(2);
    await tool("mission_schedule_toggle").execute({ id });
    await settle();
    expect(frames()).toBe(3);
    await tool("mission_schedule_delete").execute({ id });
    await settle();
    expect(frames()).toBe(4);
  });

  it("reading sends nothing", async () => {
    cron.create("n", "1h", "p");
    await settle();
    broadcastAll.mockClear();
    await tool("mission_schedule_list").execute({});
    await settle();
    expect(frames()).toBe(0);
  });
});

describe("a run reaches every tab", () => {
  it("once as it starts and once as it ends, even when its end also auto-pauses the job", async () => {
    cron.updateSettings({ maxConsecutiveFailures: 1 });
    const job = cron.create("n", "1h", "p");
    await settle();
    broadcastAll.mockClear();
    let fail!: (error: Error) => void;
    cron.onExecute(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    const run = cron.executeJob(job, { manual: true });
    await settle();
    expect(frames()).toBe(1);
    fail(new Error("site down"));
    await run;
    await settle();
    expect(frames()).toBe(2);
    expect(cron.get(job.id)).toMatchObject({ enabled: false, lastStatus: "error" });
    expect(cron.isRunning(job.id)).toBe(false);
  });
});

describe("one change is one frame", () => {
  it("writes in the same tick coalesce", async () => {
    const a = cron.create("a", "1h", "p");
    cron.toggle(a.id);
    cron.clearLastError(a.id);
    await settle();
    expect(frames()).toBe(1);
  });

  it("nothing is sent before the server wires a listener", async () => {
    const unwired = new CronService(join(dataDir, "unwired"));
    unwired.create("n", "1h", "p");
    await settle();
    expect(frames()).toBe(0);
    unwired.stop();
  });
});
