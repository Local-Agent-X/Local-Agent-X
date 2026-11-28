// The Docker check the status pages use: asked without blocking, and one
// answer shared by every caller for a few seconds.
import { beforeEach, describe, expect, it } from "vitest";
import { _resetDockerProbeForTest, probeDockerAvailable } from "./docker-shell.js";

describe("probeDockerAvailable", () => {
  beforeEach(() => _resetDockerProbeForTest());

  it("is true when `docker info` succeeds and false when it fails", async () => {
    expect(await probeDockerAvailable({ executable: () => "docker", info: async () => {} })).toBe(true);
    _resetDockerProbeForTest();
    expect(await probeDockerAvailable({ executable: () => "docker", info: async () => { throw new Error("daemon not running"); } })).toBe(false);
  });

  it("is false without asking when no docker program is installed", async () => {
    let asked = 0;
    expect(await probeDockerAvailable({ executable: () => null, info: async () => { asked++; } })).toBe(false);
    expect(asked).toBe(0);
  });

  it("asks once for callers that overlap, and again only after ten seconds", async () => {
    let asked = 0;
    let clock = 1_000;
    const deps = { now: () => clock, executable: () => "docker", info: async () => { asked++; } };
    const [a, b] = await Promise.all([probeDockerAvailable(deps), probeDockerAvailable(deps)]);
    expect([a, b]).toEqual([true, true]);
    expect(asked).toBe(1);
    clock += 9_999;
    await probeDockerAvailable(deps);
    expect(asked).toBe(1);
    clock += 1;
    await probeDockerAvailable(deps);
    expect(asked).toBe(2);
  });
});
