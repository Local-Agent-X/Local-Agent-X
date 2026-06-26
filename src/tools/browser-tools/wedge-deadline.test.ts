import { describe, it, expect, vi } from "vitest";
import { raceWedgeDeadline, WEDGED } from "./wedge-deadline.js";
import type { ToolResult } from "../../types.js";

const hung = (): Promise<ToolResult> => new Promise<ToolResult>(() => { /* never settles */ });
const done = (content: string): Promise<ToolResult> => Promise.resolve({ content });

describe("raceWedgeDeadline", () => {
  it("resets and returns WEDGED when the action exceeds the deadline", async () => {
    const reset = vi.fn();
    const r = await raceWedgeDeadline(hung(), 20, reset);
    expect(r).toBe(WEDGED);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("returns the result and never resets when the action finishes in time", async () => {
    const reset = vi.fn();
    const r = await raceWedgeDeadline(done("ok"), 1000, reset);
    expect(r).toEqual({ content: "ok" });
    expect(reset).not.toHaveBeenCalled();
  });

  it("treats deadlineMs <= 0 as unbounded — no deadline, no reset", async () => {
    const reset = vi.fn();
    const r = await raceWedgeDeadline(done("x"), 0, reset);
    expect(r).toEqual({ content: "x" });
    expect(reset).not.toHaveBeenCalled();
  });
});
