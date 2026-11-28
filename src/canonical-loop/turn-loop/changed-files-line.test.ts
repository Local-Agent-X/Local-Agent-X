// After a summary, the request's changed files are named from the change
// records, not from the summary.
import { describe, expect, it, vi, beforeEach } from "vitest";

const plan = vi.fn();
const session = vi.fn();
vi.mock("../../autonomy/rollback-rewind.js", () => ({ planRewind: (...a: unknown[]) => plan(...a) }));
vi.mock("../../ops/session-bridge.js", () => ({ getSessionForOp: (...a: unknown[]) => session(...a) }));

const { changedFilesCarry } = await import("./changed-files-line.js");

beforeEach(() => { plan.mockReset(); session.mockReset(); });

describe("changedFilesCarry", () => {
  it("names the files this request changed", () => {
    session.mockReturnValue("s1");
    plan.mockReturnValue({ files: ["C:/w/app/index.html", "C:/w/app/game.js"], laterRequests: 0 });
    expect(changedFilesCarry("op1")).toBe("[Files you have changed in this request: C:/w/app/index.html, C:/w/app/game.js. Re-read one before editing it again.]\n");
    expect(plan).toHaveBeenCalledWith("s1", "op1");
  });

  it("caps a long list and says how many more", () => {
    session.mockReturnValue("s1");
    plan.mockReturnValue({ files: Array.from({ length: 45 }, (_, i) => `f${i}.ts`), laterRequests: 0 });
    expect(changedFilesCarry("op1")).toContain("(+5 more)");
  });

  it("is empty without an op, a session, any changes, or when the records cannot be read", () => {
    expect(changedFilesCarry(undefined)).toBe("");
    session.mockReturnValue(undefined);
    expect(changedFilesCarry("op1")).toBe("");
    session.mockReturnValue("s1");
    plan.mockReturnValue(null);
    expect(changedFilesCarry("op1")).toBe("");
    plan.mockImplementation(() => { throw new Error("corrupt"); });
    expect(changedFilesCarry("op1")).toBe("");
  });
});
