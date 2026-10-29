// What a turn records as elapsed time never goes negative when the wall clock
// steps back. TB2 build-pmars (2026-10-28): the container's clock went back
// about 0.2 s during a model call, modelMs was negative, the turn commit
// refused the row and the op failed with the task half done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { elapsedMs, monotonicNow } from "./elapsed.js";
import { functionToolDispatcher } from "./tool-dispatch.js";

afterEach(() => vi.restoreAllMocks());

/** The wall clock reads 5 s earlier on every call after the first. */
function clockStepsBack(): void {
  let wall = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => (wall -= 5_000));
}

describe("elapsedMs", () => {
  it("counts whole milliseconds from a monotonicNow reading", async () => {
    const start = monotonicNow();
    await new Promise((r) => setTimeout(r, 20));
    const ms = elapsedMs(start);
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(15);
  });

  it("stays at zero or above while the wall clock steps back", () => {
    clockStepsBack();
    const start = monotonicNow();
    const before = Date.now();
    expect(Date.now()).toBeLessThan(before); // the stub is live
    expect(elapsedMs(start)).toBeGreaterThanOrEqual(0);
  });

  it("a dispatched tool's durationMs stays non-negative across a step back", async () => {
    clockStepsBack();
    const dispatcher = functionToolDispatcher(async () => ({ status: "ok", result: "done" }));
    const out = await dispatcher.dispatch({ toolCallId: "c1", tool: "bash", args: {} });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("durations a turn commits are not read off the wall clock", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = ["turn-loop.ts", "turn-loop/model-call.ts", "chat-tool-dispatcher.ts", "tool-dispatch.ts"];
  it.each(files)("%s measures with elapsed.js, never Date.now() - start", (file) => {
    const src = readFileSync(join(here, file), "utf-8");
    expect(src).toMatch(/from "\.\.?\/(?:\.\.\/)?elapsed\.js"/);
    expect(src).not.toMatch(/Date\.now\(\)\s*-\s*\w/);
  });
});
