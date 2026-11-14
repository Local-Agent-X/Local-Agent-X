import { describe, expect, it, vi } from "vitest";

import { autoStartOrder, autoStartVoiceSidecars, type AutoStartDeps } from "./auto-start.js";
import { IS_WIN, TIERS } from "./tiers.js";

describe("autoStartOrder", () => {
  it("starts nothing the user did not switch on", () => {
    expect(autoStartOrder([])).toEqual([]);
  });

  it("brings Lite with a clone worker, and starts Lite first", () => {
    expect(autoStartOrder(["studio-vox"])).toEqual(["lite", "studio-vox"]);
    expect(autoStartOrder(["studio-vox", "studio"])).toEqual(["lite", "studio", "studio-vox"]);
  });

  it("ignores ids that are not sidecars", () => {
    expect(autoStartOrder(["native", "nope", "lite"])).toEqual(["lite"]);
  });
});

describe("autoStartVoiceSidecars", () => {
  const deps = (over: Partial<AutoStartDeps>): AutoStartDeps => ({
    wanted: () => ["lite", "studio", "studio-vox"],
    installed: () => true,
    start: vi.fn(async () => ({ ok: true as const })),
    ...over,
  });

  it("starts each one in order, one at a time", async () => {
    const started: string[] = [];
    const up = await autoStartVoiceSidecars(deps({ start: async (id) => { started.push(id); return { ok: true }; } }));
    expect(started).toEqual(["lite", "studio", "studio-vox"]);
    expect(up).toEqual(["lite", "studio", "studio-vox"]);
  });

  it("skips one that is not installed and goes on after one that fails", async () => {
    const start = vi.fn(async (id: string) => id === "studio"
      ? { ok: false as const, reason: "exited" as const, exitCode: 1, logTail: "" }
      : { ok: true as const });
    const up = await autoStartVoiceSidecars(deps({ installed: (id) => id !== "lite", start }));
    expect(start).not.toHaveBeenCalledWith("lite");
    expect(up).toEqual(["studio-vox"]);
  });

  it("does nothing when none is switched on", async () => {
    const start = vi.fn();
    expect(await autoStartVoiceSidecars(deps({ wanted: () => [], start }))).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});

// A venv's python.exe is a launcher whose child got a console window of its own
// when started detached: a window on the desktop for as long as the sidecar ran.
describe("sidecars run without a console window", () => {
  it.runIf(IS_WIN)("starts every sidecar under the venv's pythonw.exe", () => {
    for (const tier of TIERS.filter((t) => t.kind !== "native")) {
      expect(tier.startCmd().command.toLowerCase()).toMatch(/scripts[\\/]pythonw\.exe$/);
    }
  });
});
