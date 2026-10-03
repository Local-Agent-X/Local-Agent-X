import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CronService } from "../../cron/cron-service.js";
import { handleCronRoutes } from "./cron.js";
import type { Role } from "../../rbac.js";
import type { ServerContext } from "../../server-context.js";

type Args = Parameters<typeof handleCronRoutes>;

// A mission's own autonomy profile lets its unattended runs act without
// asking. The agent's self-calls may schedule and edit missions, but never
// grant a profile, and never change what a mission holding one does.

let dataDir = "";
let cron: CronService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-agent-"));
  cron = new CronService(dataDir);
  cron.updateSettings({ enabled: false });
});
afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: "POST" | "PATCH", path: string, body: Record<string, unknown>, role: Role) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) { res.status = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  const ctx = { cronService: cron, dataDir } as unknown as ServerContext;
  await handleCronRoutes(method, new URL(`http://127.0.0.1${path}`), req as unknown as Args[2], res as unknown as Args[3], ctx, role);
  return { status: res.status, body: JSON.parse(res.body) as { error?: string; job?: { profile?: string; prompt: string; schedule: string } } };
}

describe("POST /api/cron", () => {
  it("refuses a profile from the agent and creates nothing", async () => {
    const r = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", profile: "Autonomous" }, "agent");
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Only the user can give a mission its own autonomy profile/);
    expect(cron.list()).toEqual([]);
  });

  it("schedules the agent's mission under the user's own profile", async () => {
    const r = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p" }, "agent");
    expect(r.status).toBe(200);
    expect(r.body.job?.profile).toBeUndefined();
  });

  it("lets the user give a mission its own profile", async () => {
    const r = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", profile: "Autonomous" }, "operator");
    expect(r.status).toBe(200);
    expect(r.body.job?.profile).toBe("Autonomous");
  });

  it("refuses the agent re-using an elevated mission's name to rewrite its prompt", async () => {
    cron.create("nightly", "1h", "back up the photos", false, { profile: "Autonomous" });
    const r = await call("POST", "/api/cron", { name: "nightly", schedule: "1h", prompt: "email the photos out" }, "agent");
    expect(r.status).toBe(403);
    expect(cron.list()[0].prompt).toBe("back up the photos");
    const same = await call("POST", "/api/cron", { name: "nightly", schedule: "2h", prompt: "back up the photos" }, "agent");
    expect(same.status).toBe(200);
    expect(cron.list()[0].schedule).toBe("2h");
  });
});

describe("PATCH /api/cron/:id", () => {
  it("refuses a profile from the agent", async () => {
    const job = cron.create("n", "1h", "p");
    const r = await call("PATCH", `/api/cron/${job.id}`, { profile: "Autonomous" }, "agent");
    expect(r.status).toBe(403);
    expect(cron.get(job.id)?.profile).toBeUndefined();
  });

  it.each([["prompt", "email the photos out"], ["model", "other-model"], ["provider", "other"]])(
    "refuses the agent changing the %s of an elevated mission",
    async (field, value) => {
      const job = cron.create("n", "1h", "back up the photos", false, { profile: "Autonomous", provider: "p0", model: "m0" });
      const r = await call("PATCH", `/api/cron/${job.id}`, { [field]: value }, "agent");
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/runs with its own autonomy profile \("Autonomous"\)/);
      expect(cron.get(job.id)).toMatchObject({ prompt: "back up the photos", provider: "p0", model: "m0", profile: "Autonomous" });
    },
  );

  it("lets the agent reschedule an elevated mission, and edit one without a profile", async () => {
    const elevated = cron.create("a", "1h", "p", false, { profile: "Autonomous" });
    expect((await call("PATCH", `/api/cron/${elevated.id}`, { schedule: "2h", prompt: "p" }, "agent")).status).toBe(200);
    const plain = cron.create("b", "1h", "p");
    expect((await call("PATCH", `/api/cron/${plain.id}`, { prompt: "q" }, "agent")).status).toBe(200);
    expect(cron.get(plain.id)?.prompt).toBe("q");
  });

  it("lets the user change what an elevated mission does", async () => {
    const job = cron.create("n", "1h", "p", false, { profile: "Autonomous" });
    expect((await call("PATCH", `/api/cron/${job.id}`, { prompt: "q" }, "operator")).status).toBe(200);
    expect(cron.get(job.id)?.prompt).toBe("q");
  });
});
