import { describe, it, expect, vi } from "vitest";
import { runModelCall, modelCallSignals, type ModelCall } from "./model-call.js";
import { extractText } from "./content-extract.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { Op } from "../../ops/types.js";

let seq = 0;
const freshOp = (): Op => ({ id: `op-model-call-${seq++}`, type: "chat_turn", lane: "interactive" }) as unknown as Op;
const input = (op: Op): TurnInput => ({ opId: op.id, turnIdx: 0, messages: [], tools: [] });

function scriptedAdapter(reports: AdapterReport[], result: Partial<TurnResult> = {}): Adapter {
  return {
    name: "scripted",
    version: "0",
    runTurn: vi.fn(async (_in: TurnInput, report: (r: AdapterReport) => void) => {
      for (const r of reports) report(r);
      return { providerState: {}, ...result } as TurnResult;
    }),
    abort: vi.fn(async () => {}),
  };
}

function makeDeps() {
  return {
    emit: vi.fn(),
    publishStreamChunk: vi.fn(),
    createIdleWatchdog: vi.fn(() => ({ noteActivity: vi.fn(), disarm: vi.fn() })),
    readIdleTimeoutMs: vi.fn(() => 600000),
    extractText,
  };
}

async function returned(adapter: Adapter, deps = makeDeps()): Promise<ModelCall> {
  const outcome = await runModelCall(freshOp(), adapter, input(freshOp()), 0, deps);
  if (outcome.kind !== "returned") throw new Error("expected a returned model call");
  return outcome.call;
}

describe("runModelCall — folding the report stream", () => {
  it("forwards stream, reasoning and redact chunks to the bus and collects the rest", async () => {
    const deps = makeDeps();
    const call = await returned(scriptedAdapter([
      { kind: "stream_chunk", body: { delta: "hi" } },
      { kind: "reasoning_chunk", delta: "thinking" },
      { kind: "stream_redact", replacementText: "clean" },
      { kind: "message_finalized", message: { role: "assistant", content: { text: "Hello " } } },
      { kind: "message_finalized", message: { role: "user", content: { text: "ignored" } } },
      { kind: "message_finalized", message: { role: "assistant", content: "world" } },
      { kind: "tool_call_requested", call: { toolCallId: "c1", tool: "read_file", args: {} } },
      { kind: "tool_observed", tool: "mcp__x__y" },
    ] as AdapterReport[]), deps);

    expect(deps.publishStreamChunk.mock.calls.map(c => c[1])).toEqual([
      { delta: "hi" },
      { reasoning: true, delta: "thinking" },
      { replace: true, text: "clean" },
    ]);
    expect(call.finalized).toHaveLength(3);
    expect(call.assistantText).toBe("Hello world");
    expect(call.toolCalls.map(c => c.toolCallId)).toEqual(["c1"]);
    expect(call.observedTools).toEqual(["mcp__x__y"]);
    expect(call.sawReasoning).toBe(true);
    expect(call.adapterError).toBeNull();
  });

  it("counts a heartbeat as reasoning without publishing anything", async () => {
    const deps = makeDeps();
    const call = await returned(scriptedAdapter([{ kind: "heartbeat" }]), deps);
    expect(call.sawReasoning).toBe(true);
    expect(deps.publishStreamChunk).not.toHaveBeenCalled();
  });

  it("records a reported error and emits it as an `error` event", async () => {
    const deps = makeDeps();
    const call = await returned(scriptedAdapter([
      { kind: "error", code: "bad_request", message: "nope", retryable: false },
    ] as AdapterReport[]), deps);
    expect(call.adapterError).toEqual({ code: "bad_request", message: "nope", retryable: false });
    expect(deps.emit).toHaveBeenCalledWith(expect.any(String), "error", { code: "bad_request", message: "nope", retryable: false });
  });

  it("a stall records `stalled` and aborts the adapter with the idle-stalled reason", async () => {
    const deps = makeDeps();
    let onTimeout: () => void = () => {};
    deps.createIdleWatchdog.mockImplementation(((opts: { onTimeout: () => void }) => {
      onTimeout = opts.onTimeout;
      return { noteActivity: vi.fn(), disarm: vi.fn() };
    }) as never);
    const adapter = scriptedAdapter([]);
    (adapter.runTurn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      onTimeout();
      return { providerState: {} } as TurnResult;
    });
    const call = await returned(adapter, deps);
    expect(call.adapterError?.code).toBe("stalled");
    expect(adapter.abort).toHaveBeenCalledWith(expect.objectContaining({ message: "idle-stalled" }));
  });

  it("notes activity on every report and disarms the watchdog once the call returns", async () => {
    const deps = makeDeps();
    const watchdog = { noteActivity: vi.fn(), disarm: vi.fn() };
    deps.createIdleWatchdog.mockReturnValue(watchdog);
    await returned(scriptedAdapter([{ kind: "heartbeat" }, { kind: "stream_chunk", body: {} }] as AdapterReport[]), deps);
    expect(watchdog.noteActivity).toHaveBeenCalledTimes(2);
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
  });
});

describe("modelCallSignals — what the model call tells decideTurnOutcome", () => {
  const base = (result: Partial<TurnResult>): ModelCall => ({
    result: { providerState: {}, ...result } as TurnResult,
    finalized: [], toolCalls: [], observedTools: [], sawReasoning: false,
    adapterError: null, assistantText: "", modelMs: 0,
  });

  it("maps the model's stop signal and the provider's raw stop reason", () => {
    const ended = modelCallSignals(base({
      modelStop: "ended", terminalReason: "done",
      providerState: { providerPayload: { stopReason: "end_turn" } } as TurnResult["providerState"],
    }));
    expect(ended).toMatchObject({ modelSignaledDone: true, modelWantsToContinue: false, adapterTerminalReason: "done", providerStop: "end_turn" });

    const cont = modelCallSignals(base({ modelStop: "continue" }));
    expect(cont).toMatchObject({ modelSignaledDone: false, modelWantsToContinue: true, adapterTerminalReason: null, providerStop: undefined });
  });

  it("passes the live tool-call array through by reference", () => {
    const call = base({});
    expect(modelCallSignals(call).toolCalls).toBe(call.toolCalls);
  });
});
