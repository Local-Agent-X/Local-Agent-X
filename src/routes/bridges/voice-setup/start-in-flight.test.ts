// A second start of a tier while one is under way joins it. A repeated start
// begins by killing the tier, which would kill a sidecar still cold-starting;
// the desktop's Settings and the paired phone can both start the voice system.
import { describe, expect, it, vi } from "vitest";

let answer: (v: { ok: boolean }) => void = () => {};
const probe = vi.fn(() => new Promise<{ ok: boolean }>((r) => { answer = r; }));
vi.mock("./detection.js", () => ({ probeHealth: probe }));

const { startTierAndWait } = await import("./process-control.js");
const { tierById } = await import("./tiers.js");

describe("startTierAndWait", () => {
  it("joins a start already under way for the tier instead of starting again", async () => {
    const lite = tierById("lite")!;
    const first = startTierAndWait(lite);
    const second = startTierAndWait(lite);
    expect(second).toBe(first);
    answer({ ok: true });
    expect(await first).toEqual({ ok: true, adopted: true });
    expect(probe).toHaveBeenCalledTimes(1);

    // Once it has settled, the next start is a start of its own.
    const third = startTierAndWait(lite);
    expect(third).not.toBe(first);
    answer({ ok: true });
    await third;
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
