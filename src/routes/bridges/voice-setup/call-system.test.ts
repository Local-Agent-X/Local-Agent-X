import { describe, expect, it } from "vitest";
import { callSystemTiers, createCallSystem, type CallSystemDeps } from "./call-system.js";
import { tierById, type VoiceTier } from "./tiers.js";
import type { StartOutcome } from "./process-control.js";
import { agentDeniedRouteFor } from "../../../rbac-agent-denials.js";
import { isDeviceAllowedPath } from "../../../broker-transport/device-paths.js";
import { VOICE_SYSTEM_PATH, VOICE_SYSTEM_START_PATH } from "../../../broker-transport/vendor/voice.js";

const lite = tierById("lite")!;
const vox = tierById("studio-vox")!;

describe("the voice system a call needs", () => {
  it("is the saved voice's: a cloned voice adds its engine after Lite, the in-process engine needs none", () => {
    expect(callSystemTiers("python", "vx:optimus")?.map((t) => t.id)).toEqual(["lite", "studio-vox"]);
    expect(callSystemTiers("python", "cb:optimus")?.map((t) => t.id)).toEqual(["lite", "studio"]);
    expect(callSystemTiers("python", "am_onyx")?.map((t) => t.id)).toEqual(["lite"]);
    expect(callSystemTiers("python", undefined)?.map((t) => t.id)).toEqual(["lite"]);
    expect(callSystemTiers("tier4", "vx:optimus")).toBeNull();
  });
});

function fake(over: Partial<CallSystemDeps> & { up?: Set<string> } = {}) {
  const up = over.up ?? new Set<string>();
  const started: string[] = [];
  let release: (o: StartOutcome) => void = () => {};
  const deps: CallSystemDeps = {
    tiers: () => [lite, vox],
    installed: () => true,
    healthy: async (t: VoiceTier) => up.has(t.id),
    start: (t: VoiceTier) => {
      started.push(t.id);
      return new Promise<StartOutcome>((r) => { release = (o) => { if (o.ok) up.add(t.id); r(o); }; });
    },
    ...over,
  };
  return { system: createCallSystem(deps), started, up, finish: (o: StartOutcome) => release(o) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("reading and starting it from the phone", () => {
  it("says stopped, then starting at once, then running once each part is up, in order", async () => {
    const f = fake();
    expect(await f.system.status()).toEqual({ state: "stopped", label: vox.label });
    expect(await f.system.start()).toEqual({ state: "starting", label: vox.label });
    expect(f.started).toEqual(["lite"]);
    f.finish({ ok: true });
    await settle();
    expect(f.started).toEqual(["lite", "studio-vox"]);
    f.finish({ ok: true });
    await settle();
    expect(await f.system.status()).toEqual({ state: "running", label: vox.label });
  });

  it("does not start twice while a start is under way", async () => {
    const f = fake();
    await f.system.start();
    expect(await f.system.start()).toEqual({ state: "starting", label: vox.label });
    expect(f.started).toEqual(["lite"]);
  });

  it("reports a failed start with what happened, and a new start clears it", async () => {
    const f = fake();
    await f.system.start();
    f.finish({ ok: false, reason: "exited", exitCode: 1, logTail: "Traceback: boom" });
    await settle();
    const failed = await f.system.status();
    expect(failed.state).toBe("failed");
    expect(failed.message).toContain("crashed on startup");
    expect(failed.message).not.toContain("Traceback");
    expect(f.started).toEqual(["lite"]);
    expect((await f.system.start()).state).toBe("starting");
  });

  it("starts nothing that is running, not installed, or built in", async () => {
    const running = fake({ up: new Set(["lite", "studio-vox"]) });
    expect((await running.system.start()).state).toBe("running");
    const missing = fake({ installed: (t) => t.id !== "studio-vox" });
    const s = await missing.system.start();
    expect(s.state).toBe("not-installed");
    expect(s.message).toContain(vox.label);
    const builtIn = fake({ tiers: () => null });
    expect(await builtIn.system.start()).toEqual({ state: "built-in", label: "Built-in voice" });
    expect([...running.started, ...missing.started, ...builtIn.started]).toEqual([]);
  });
});

// The phone may reach these two paths and no other voice-setup route; the agent
// may reach none of them (it is refused all of /api/voices/setup).
describe("who can reach it", () => {
  it("the paired phone, and only these paths of voice setup", () => {
    expect(isDeviceAllowedPath(VOICE_SYSTEM_PATH)).toBe(true);
    expect(isDeviceAllowedPath(VOICE_SYSTEM_START_PATH)).toBe(true);
    for (const p of ["/api/voices/setup/status", "/api/voices/setup/start", "/api/voices/setup/install", "/api/voices/setup/repair", "/api/voices/setup/stop", "/api/voices/doctor"]) {
      expect(isDeviceAllowedPath(p), p).toBe(false);
    }
  });

  it("never the agent", () => {
    expect(agentDeniedRouteFor(VOICE_SYSTEM_PATH)?.prefix).toBe("/api/voices/setup");
    expect(agentDeniedRouteFor(VOICE_SYSTEM_START_PATH)?.prefix).toBe("/api/voices/setup");
  });
});
