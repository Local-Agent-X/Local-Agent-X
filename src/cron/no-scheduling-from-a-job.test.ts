/**
 * A run with no one watching does not read or change the schedule.
 *
 * The rule was a name prefix (`mission_schedule_`) filtered out of three tool
 * lists: a delegated worker's, an autopilot round's and a scheduled job's. For
 * the job that did not hold. A tool called by name is loaded on the spot
 * (canonical-loop/tool-augmentation.ts), and only a delegated worker's
 * denylist was checked there, so a scheduled job could call
 * mission_schedule_create and install another job.
 *
 * The rule is now on the tools' policy rows: the `scheduling` tag is what the
 * unattended lists leave out, and `deniedIn.cron` makes the security layer
 * refuse the call itself. The loop's half (a job cannot load one by name) is
 * in canonical-loop/tool-augmentation.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCronTools } from "./tools.js";
import { deniedInContext, toolsTagged } from "../tool-registry.js";
import { SecurityLayer } from "../security/index.js";
import { isDeniedForDelegatedWorker } from "../ops/tools/delegated-toolset.js";

const MISSION_TOOLS = createCronTools({} as never)
  .map((t) => t.name)
  .filter((name) => name.startsWith("mission_schedule_"))
  .sort();

const WORKSPACE = mkdtempSync(join(tmpdir(), "no-scheduling-from-a-job-"));
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }));

describe("the scheduling tools, by their rows", () => {
  it("every mission_schedule tool is tagged scheduling, and nothing else is", () => {
    expect(MISSION_TOOLS).toHaveLength(6);
    expect([...toolsTagged("scheduling")].sort()).toEqual(MISSION_TOOLS);
  });

  it("each one's row refuses a scheduled job, and says why", () => {
    for (const name of MISSION_TOOLS) {
      expect(deniedInContext(name, "cron"), name).toMatch(/scheduled job/);
      expect(deniedInContext(name, "local"), name).toBeUndefined();
    }
  });

  it("a delegated worker is never given one", () => {
    for (const name of MISSION_TOOLS) expect(isDeniedForDelegatedWorker(name), name).toBe(true);
  });
});

describe("a scheduled job that calls one anyway", () => {
  it("is refused by the security layer at the call; the same call from a chat is not", () => {
    const security = new SecurityLayer(WORKSPACE, "workspace");
    for (const name of MISSION_TOOLS) {
      const fromJob = security.evaluate({ toolName: name, args: {}, sessionId: "cron-job-1", callContext: "cron" });
      expect(fromJob.allowed, name).toBe(false);
      expect(fromJob.reason, name).toContain("cron context");
      expect(security.evaluate({ toolName: name, args: {}, sessionId: "chat-1", callContext: "local" }).allowed, name).toBe(true);
    }
  });
});
