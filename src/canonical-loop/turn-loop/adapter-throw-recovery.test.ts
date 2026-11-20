// A thrown adapter error is fed back to the model and retried, twice, as a
// transient fault. A rejected credential or a content filter is not one: it
// answers the same every time, and retrying it told the model it was transient.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ transitions: [] as string[], nudges: 0, errors: [] as Array<{ code: string; retryable: boolean }> }));
vi.mock("../event-emitter.js", () => ({
  emit: (_op: string, _type: string, body: { code: string; retryable: boolean }) => { calls.errors.push(body); },
  publishStreamChunk: () => {},
}));
vi.mock("../state-machine.js", () => ({ transitionOp: (_op: unknown, to: string) => { calls.transitions.push(to); } }));
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: () => { calls.nudges++; } }));
vi.mock("./compact-history.js", () => ({ forceCompactNext: () => {} }));

const { recoverAdapterThrow } = await import("./adapter-throw-recovery.js");

let n = 0;
const op = () => ({ id: `op-throw-${++n}` }) as never;

beforeEach(() => { calls.transitions = []; calls.nudges = 0; calls.errors = []; });

describe("recoverAdapterThrow", () => {
  it("retries a transient throw with a resume nudge", () => {
    const r = recoverAdapterThrow(op(), new Error("xai call threw: The operation was aborted due to timeout"), 3);
    expect(r.terminalReason).toBeNull();
    expect(calls.nudges).toBe(1);
    expect(calls.transitions).toEqual([]);
  });

  it.each([
    ["a rejected credential", Object.assign(new Error("401 invalid x-api-key"), { status: 401 })],
    ["a content filter", new Error("content_filter: output blocked by the provider's safety system")],
  ])("fails the op at once on %s, without telling the model it was transient", (_label, error) => {
    const r = recoverAdapterThrow(op(), error, 3);
    expect(r.terminalReason).toBe("error");
    expect(calls.nudges).toBe(0);
    expect(calls.transitions).toEqual(["failed"]);
    expect(calls.errors).toEqual([expect.objectContaining({ code: "adapter_error_permanent", retryable: false })]);
  });
});
