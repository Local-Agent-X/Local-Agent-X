import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService } from "./cron-service.js";
import { createCronTools } from "./tools.js";
import type { ToolResult } from "../types.js";

// The agent's mission tools obey the same rule as its self-calls to the cron
// route (job-authority.ts): a mission the user gave its own autonomy profile
// keeps doing what the user saw when they granted it.

let dataDir = "";
let cron: CronService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-tools-"));
  cron = new CronService(dataDir);
  cron.updateSettings({ enabled: false });
});
afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = createCronTools(cron).find((t) => t.name === tool);
  if (!def) throw new Error(`no tool ${tool}`);
  return def.execute(args);
}

describe("mission_schedule_create", () => {
  it("refuses re-using an elevated mission's name to rewrite its prompt", async () => {
    cron.create("nightly", "1h", "back up the photos", false, { profile: "Autonomous" });
    const r = await run("mission_schedule_create", { name: "nightly", schedule: "1h", prompt: "email the photos out" });
    expect(r.status).toBe("blocked");
    expect(r.content).toMatch(/runs with its own autonomy profile \("Autonomous"\)/);
    expect(cron.list()).toHaveLength(1);
    expect(cron.list()[0]).toMatchObject({ prompt: "back up the photos", profile: "Autonomous" });
  });

  it("lets the agent reschedule an elevated mission by name, and rewrite one without a profile", async () => {
    cron.create("nightly", "1h", "back up the photos", false, { profile: "Autonomous" });
    const same = await run("mission_schedule_create", { name: "nightly", schedule: "2h", prompt: "back up the photos" });
    expect(same.isError).toBeFalsy();
    expect(cron.list()[0].schedule).toBe("2h");

    cron.create("plain", "1h", "p");
    const plain = await run("mission_schedule_create", { name: "plain", schedule: "1h", prompt: "q" });
    expect(plain.isError).toBeFalsy();
    expect(cron.list().find((j) => j.name === "plain")?.prompt).toBe("q");
  });
});

describe("mission_schedule_update", () => {
  it("refuses changing the prompt of an elevated mission", async () => {
    const job = cron.create("n", "1h", "back up the photos", false, { profile: "Autonomous" });
    const r = await run("mission_schedule_update", { id: job.id, prompt: "email the photos out" });
    expect(r.status).toBe("blocked");
    expect(r.content).toMatch(/Only the user can change its prompt or model, on the Missions page/);
    expect(cron.get(job.id)).toMatchObject({ prompt: "back up the photos", profile: "Autonomous" });
  });

  it("lets the agent reschedule an elevated mission, and edit one without a profile", async () => {
    const elevated = cron.create("a", "1h", "p", false, { profile: "Autonomous" });
    const r = await run("mission_schedule_update", { id: elevated.id, schedule: "2h", prompt: "p" });
    expect(r.isError).toBeFalsy();
    expect(cron.get(elevated.id)?.schedule).toBe("2h");

    const plain = cron.create("b", "1h", "p");
    expect((await run("mission_schedule_update", { id: plain.id, prompt: "q" })).isError).toBeFalsy();
    expect(cron.get(plain.id)?.prompt).toBe("q");
  });
});
