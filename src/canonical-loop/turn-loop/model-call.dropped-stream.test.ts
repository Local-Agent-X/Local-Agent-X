// A connection that drops after the turn has streamed is recovered like a
// thrown error (retract, resume, bounded), not failed: nothing in the turn was
// committed. Before, the op failed 36 minutes in (glasses chat, 2026-11-27).
import { beforeEach, describe, expect, it, vi } from "vitest";

const recovery = vi.hoisted(() => ({
  recoverAdapterThrow: vi.fn(() => ({ terminalReason: null, toolCount: 0, messageCount: 0, cancelled: false })),
  clearAdapterThrowStreak: vi.fn(),
}));
vi.mock("./adapter-throw-recovery.js", async (orig) => ({
  ...(await orig<typeof import("./adapter-throw-recovery.js")>()),
  ...recovery,
}));

const { runModelCall } = await import("./model-call.js");
const { extractText } = await import("./content-extract.js");
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { Op } from "../../ops/types.js";

const op = { id: "op-dropped", type: "chat_turn", lane: "interactive" } as unknown as Op;
const input: TurnInput = { opId: op.id, turnIdx: 3, messages: [], tools: [] };
const deps = () => ({
  emit: vi.fn(),
  publishStreamChunk: vi.fn(),
  createIdleWatchdog: vi.fn(() => ({ noteActivity: vi.fn(), disarm: vi.fn() })),
  readIdleTimeoutMs: vi.fn(() => 600000),
  extractText,
});
const adapter = (reports: AdapterReport[]): Adapter => ({
  name: "scripted",
  version: "0",
  runTurn: vi.fn(async (_in: TurnInput, report: (r: AdapterReport) => void) => {
    for (const r of reports) report(r);
    return { providerState: {} } as TurnResult;
  }),
  abort: vi.fn(async () => {}),
});
const dropped: AdapterReport = { kind: "error", code: "transport_error", message: "Anthropic error: terminated", retryable: false };

beforeEach(() => {
  recovery.recoverAdapterThrow.mockClear();
  recovery.clearAdapterThrowStreak.mockClear();
});

describe("a dropped connection mid-turn", () => {
  it("is recovered like a thrown error once reasoning has streamed, before the retry streak is cleared", async () => {
    const out = await runModelCall(op, adapter([{ kind: "reasoning_chunk", delta: "settling the design" }, dropped]), input, 3, deps());
    expect(out.kind).toBe("ended");
    expect(recovery.recoverAdapterThrow).toHaveBeenCalledWith(op, expect.objectContaining({ message: "Anthropic error: terminated" }), 3);
    expect(recovery.clearAdapterThrowStreak).not.toHaveBeenCalled();
  });

  it("is not redone once the turn asked for a tool: that call may have run", async () => {
    const out = await runModelCall(op, adapter([
      { kind: "tool_call_requested", call: { toolCallId: "c1", tool: "write", args: {} } },
      dropped,
    ] as AdapterReport[]), input, 3, deps());
    expect(out.kind).toBe("returned");
    expect(recovery.recoverAdapterThrow).not.toHaveBeenCalled();
  });

  it("leaves a failure that is not transient to the normal path", async () => {
    const out = await runModelCall(op, adapter([
      { kind: "stream_chunk", body: { delta: "partial" } },
      { kind: "error", code: "bad_request", message: "invalid request: messages.3 is malformed", retryable: false },
    ] as AdapterReport[]), input, 3, deps());
    expect(out.kind).toBe("returned");
    expect(recovery.recoverAdapterThrow).not.toHaveBeenCalled();
  });
});
