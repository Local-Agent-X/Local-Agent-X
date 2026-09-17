// The rolling profile must contain the stall itself, not only what follows it.
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const env = vi.hoisted(() => {
  const dir = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/lax-rolling-${process.pid}-${Date.now()}`;
  process.env.LAX_DATA_DIR = dir;
  process.env.LAX_LOOP_SENTINEL_ROLLING = "1";
  return { dir };
});
import { defaultStallCapture } from "./rolling-stall-profile.js";

afterAll(() => { rmSync(env.dir, { recursive: true, force: true }); });

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

// Named so the profile can be searched for it.
function blockTheLoopForTheTest(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) Math.sqrt(Math.random());
}

describe("rolling stall profile", () => {
  it("records the blocking function, which an after-the-fact profile cannot", async () => {
    const capture = defaultStallCapture(log);
    await new Promise((r) => setTimeout(r, 200)); // profiler started
    blockTheLoopForTheTest(600);
    const path = capture(600);
    const deadline = Date.now() + 5_000;
    while (!existsSync(path) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const profile = JSON.parse(readFileSync(path, "utf8")) as { nodes: Array<{ callFrame: { functionName: string } }> };
    const names = profile.nodes.map((n) => n.callFrame.functionName);
    expect(names, JSON.stringify([...new Set(names)].slice(0, 40))).toContain("blockTheLoopForTheTest");
    expect(path.startsWith(join(env.dir, "logs"))).toBe(true);
  }, 15_000);
});

