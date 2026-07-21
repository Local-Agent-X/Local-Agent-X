import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  op: null as null | {
    canonical?: {
      pendingApproval?: {
        approvalId: string;
        resolution: { approved: boolean };
      };
    };
  },
  resolveApproval: vi.fn<(id: string, approved: boolean) => boolean>(),
}));

vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({ resolveApproval: mocks.resolveApproval }),
}));
vi.mock("../ops/op-store.js", () => ({ readOp: () => mocks.op }));
vi.mock("./signals.js", () => ({ publishSignal: vi.fn() }));

const { startProcessControlRelay } = await import("./process-control-relay.js");

afterEach(() => {
  vi.useRealTimers();
  mocks.op = null;
  mocks.resolveApproval.mockReset();
});

describe("process control relay", () => {
  it("retries a recovered decision until the live approval is registered", async () => {
    vi.useFakeTimers();
    mocks.op = {
      canonical: {
        pendingApproval: {
          approvalId: "approval-delayed",
          resolution: { approved: true },
        },
      },
    };
    mocks.resolveApproval.mockReturnValueOnce(false).mockReturnValue(true);

    const stop = startProcessControlRelay("op-delayed", 100);
    expect(mocks.resolveApproval).toHaveBeenCalledTimes(1);
    expect(mocks.resolveApproval).toHaveBeenLastCalledWith("approval-delayed", true);

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.resolveApproval).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.resolveApproval).toHaveBeenCalledTimes(2);
    stop();
  });
});
