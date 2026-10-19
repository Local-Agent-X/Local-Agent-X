import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const broadcastAll = vi.fn();

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-agent-"));
  cron = new CronService(dataDir);
  cron.updateSettings({ enabled: false });
  broadcastAll.mockClear();
});
afterEach(() => {
  cron.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown>, role: Role) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) { res.status = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  const ctx = { cronService: cron, dataDir, broadcastAll } as unknown as ServerContext;
  await handleCronRoutes(method, new URL(`http://127.0.0.1${path}`), req as unknown as Args[2], res as unknown as Args[3], ctx, role);
  return { status: res.status, body: JSON.parse(res.body) as { error?: string; job?: { id: string; profile?: string; prompt: string; schedule: string; imageEngine?: string; useSignedInBrowser?: boolean } } };
}

const MISSIONS_CHANGED = { type: "settings_changed", settings: { missions: true } };

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

describe("a mission's image engine", () => {
  it("is saved with the mission and every tab is told; an empty engine clears it back to the default", async () => {
    const created = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", imageEngine: "chatgpt" }, "operator");
    expect(created.status).toBe(200);
    expect(created.body.job?.imageEngine).toBe("chatgpt");
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
    const id = created.body.job!.id;
    broadcastAll.mockClear();
    expect((await call("PATCH", `/api/cron/${id}`, { imageEngine: "grok" }, "operator")).body.job?.imageEngine).toBe("grok");
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
    expect((await call("PATCH", `/api/cron/${id}`, { imageEngine: "" }, "operator")).body.job?.imageEngine).toBeUndefined();
    expect(cron.get(id)?.imageEngine).toBeUndefined();
  });

  it("refuses an engine that is not one, on create and on edit", async () => {
    expect((await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", imageEngine: "dalle" }, "operator")).status).toBe(400);
    expect(cron.list()).toEqual([]);
    const job = cron.create("n", "1h", "p");
    const r = await call("PATCH", `/api/cron/${job.id}`, { imageEngine: "sd" }, "operator");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/grok or chatgpt/);
    expect(broadcastAll).not.toHaveBeenCalled();
  });

  it("the agent may pick a mission's engine: cost stays with the paid-API switch", async () => {
    const r = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", imageEngine: "grok" }, "agent");
    expect(r.status).toBe(200);
    expect(r.body.job?.imageEngine).toBe("grok");
  });
});

describe("a mission's use of the user's signed-in browser", () => {
  it("is the user's to grant, never the agent's", async () => {
    const refused = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", useSignedInBrowser: true }, "agent");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only the user can let a mission browse with their signed-in browser/);
    expect(cron.list()).toEqual([]);
    const granted = await call("POST", "/api/cron", { name: "n", schedule: "1h", prompt: "p", useSignedInBrowser: true }, "operator");
    expect(granted.body.job?.useSignedInBrowser).toBe(true);
    const id = granted.body.job!.id;
    expect((await call("PATCH", `/api/cron/${id}`, { useSignedInBrowser: true }, "agent")).status).toBe(403);
    expect((await call("PATCH", `/api/cron/${id}`, { useSignedInBrowser: "yes" }, "operator")).status).toBe(400);
  });

  it("holds the agent off a granted mission's prompt and model, like a profile does", async () => {
    const job = cron.create("n", "1h", "back up the photos", false, { useSignedInBrowser: true });
    const r = await call("PATCH", `/api/cron/${job.id}`, { prompt: "post the photos everywhere" }, "agent");
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/runs with your signed-in browser/);
    expect(cron.get(job.id)?.prompt).toBe("back up the photos");
    expect((await call("PATCH", `/api/cron/${job.id}`, { schedule: "2h" }, "agent")).status).toBe(200);
  });

  it("the user takes it back with false, which clears the field", async () => {
    const job = cron.create("n", "1h", "p", false, { useSignedInBrowser: true });
    const r = await call("PATCH", `/api/cron/${job.id}`, { useSignedInBrowser: false }, "operator");
    expect(r.status).toBe(200);
    expect(r.body.job?.useSignedInBrowser).toBeUndefined();
    expect(cron.get(job.id)?.useSignedInBrowser).toBeUndefined();
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });
});

// Every tab's Missions list redraws from the broadcast: a route that changes a
// mission without it leaves the other tabs showing the old state.
describe("each mutating mission route tells every tab", () => {
  it("toggle", async () => {
    const job = cron.create("n", "1h", "p");
    expect((await call("POST", `/api/cron/${job.id}/toggle`, {}, "operator")).status).toBe(200);
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });

  it("run now", async () => {
    const job = cron.create("n", "1h", "p");
    expect((await call("POST", `/api/cron/${job.id}/run`, {}, "operator")).status).toBe(200);
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });

  it("cancel, when a run was in flight to cancel", async () => {
    const job = cron.create("n", "1h", "p");
    expect((await call("POST", `/api/cron/${job.id}/cancel`, {}, "operator")).body).toMatchObject({ cancelled: false });
    expect(broadcastAll).not.toHaveBeenCalled();
    cron.registerRunAbort(job.id, new AbortController());
    expect((await call("POST", `/api/cron/${job.id}/cancel`, {}, "operator")).body).toMatchObject({ cancelled: true });
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });

  it("delete, when there was a mission to delete", async () => {
    expect((await call("DELETE", "/api/cron/nope", {}, "operator")).body).toMatchObject({ deleted: false });
    expect(broadcastAll).not.toHaveBeenCalled();
    const job = cron.create("n", "1h", "p");
    expect((await call("DELETE", `/api/cron/${job.id}`, {}, "operator")).body).toMatchObject({ deleted: true });
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });

  it("clear error", async () => {
    const job = cron.create("n", "1h", "p");
    expect((await call("POST", `/api/cron/${job.id}/clear-error`, {}, "operator")).status).toBe(200);
    expect(broadcastAll).toHaveBeenCalledWith(MISSIONS_CHANGED);
  });

  it("not for a mission that does not exist", async () => {
    for (const action of ["toggle", "run", "cancel", "clear-error"]) {
      expect((await call("POST", `/api/cron/nope/${action}`, {}, "operator")).status).toBe(404);
    }
    expect(broadcastAll).not.toHaveBeenCalled();
  });
});
