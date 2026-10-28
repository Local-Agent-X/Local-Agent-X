import { describe, it, expect, vi } from "vitest";
import { raceWedgeDeadline, WEDGED } from "./wedge-deadline.js";
import type { ToolResult } from "../../types.js";
import { beginApprovalWait, runInApprovalWaitScope } from "../../approval-wait.js";

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

// An approval card raised mid-action (a download, a credential fill) is the
// user's time. The tool timeout and the bridge budget already exclude it; a
// flat wedge timer did not, so a card answered after the deadline reset a
// healthy browser and the action failed as "wedged".
describe("raceWedgeDeadline excludes time spent on an approval card", () => {
  const settlesAfter = (ms: number): Promise<ToolResult> =>
    new Promise<ToolResult>((resolve) => setTimeout(() => resolve({ content: "answered" }), ms));

  it("an action waiting on a card past the deadline is not reset", async () => {
    const reset = vi.fn();
    const r = await runInApprovalWaitScope(async () => {
      const endWait = beginApprovalWait();
      setTimeout(endWait, 120);
      return await raceWedgeDeadline(settlesAfter(150), 50, reset);
    });
    expect(r).toEqual({ content: "answered" });
    expect(reset).not.toHaveBeenCalled();
  });

  it("only waiting inside the action counts, and a hung action still trips once the card is answered", async () => {
    const reset = vi.fn();
    const started = Date.now();
    const r = await runInApprovalWaitScope(async () => {
      // A card answered BEFORE the action buys this deadline nothing.
      beginApprovalWait()();
      const endWait = beginApprovalWait();
      setTimeout(endWait, 60);
      return await raceWedgeDeadline(hung(), 40, reset);
    });
    expect(r).toBe(WEDGED);
    expect(reset).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeGreaterThanOrEqual(95);
  });
});
