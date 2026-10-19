import { describe, it, expect, vi, beforeEach } from "vitest";

// suspension.ts records the beforeTurn suspend's guard fire through the real
// emitter, which appends to the op's on-disk event log.
vi.mock("../event-emitter.js", () => ({ emit: vi.fn(), emitErrorOnce: vi.fn(), publishStreamChunk: vi.fn() }));

import { createTurnMiddlewarePhases, directiveSkipsToolDispatch } from "./middleware-phases.js";
import { emit } from "../event-emitter.js";
import { makeCanonicalLoopContext } from "../middlewares/ctx.test-helper.js";
import type { BuildContextArgs, FiredMiddlewareResult } from "../middlewares/host.js";
import type { CanonicalLoopContext } from "../middlewares/types.js";
import type { ModelCall } from "./model-call.js";
import type { TurnResult } from "../adapter-contract.js";
import type { Op } from "../../ops/types.js";

const op = (lane = "interactive"): Op => ({ id: "op-phases", type: "chat_turn", lane }) as unknown as Op;

function makeDeps(verdict: FiredMiddlewareResult = { kind: "continue" }) {
  const built: Array<Partial<BuildContextArgs>> = [];
  const contexts: CanonicalLoopContext[] = [];
  return {
    built,
    contexts,
    createTurnContextComposer: vi.fn(() => ({
      middlewareStack: [],
      build: (overrides: Partial<BuildContextArgs> = {}) => {
        built.push(overrides);
        const ctx = makeCanonicalLoopContext({});
        contexts.push(ctx);
        return ctx;
      },
    })),
    runMiddlewarePhase: vi.fn(async () => verdict),
    middlewareAbortResult: vi.fn(() => ({ terminalReason: "error" as const, toolCount: 0, messageCount: 0, cancelled: false })),
    appendNudgeAsUserMessage: vi.fn(() => true),
    buildToolResultsView: vi.fn(() => []),
    extractToolResultText: vi.fn(() => ""),
  };
}

const modelCall = (over: Partial<ModelCall> = {}): ModelCall => ({
  result: { providerState: { providerPayload: { usageOutputTokens: 42 } }, modelStop: "ended" } as unknown as TurnResult,
  finalized: [], toolCalls: [], observedTools: [], sawReasoning: true,
  adapterError: null, assistantText: "said", modelMs: 1,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("beforeTurn", () => {
  it("continues the turn on a continue verdict", async () => {
    const deps = makeDeps();
    expect(await createTurnMiddlewarePhases(op(), 2, deps).beforeTurn()).toBeNull();
    expect(deps.runMiddlewarePhase).toHaveBeenCalledWith(expect.anything(), "beforeTurn", []);
  });

  it("ends the turn through middlewareAbortResult on an abort", async () => {
    const deps = makeDeps({ kind: "abort", reason: "r", firedBy: "loop-detection" });
    const end = await createTurnMiddlewarePhases(op(), 2, deps).beforeTurn();
    expect(end?.terminalReason).toBe("error");
    expect(deps.middlewareAbortResult).toHaveBeenCalledWith(expect.anything(), 2, expect.objectContaining({ kind: "abort" }));
  });

  it("ends the turn as a suspension and records which guard paused it", async () => {
    const deps = makeDeps({ kind: "suspend", reason: "r", firedBy: "thrash-guard", message: "paused" });
    const end = await createTurnMiddlewarePhases(op("agent"), 2, deps).beforeTurn();
    expect(end?.middlewareDirective).toMatchObject({ kind: "suspend", firedBy: "thrash-guard" });
    expect(emit).toHaveBeenCalledWith("op-phases", "middleware_fired", expect.objectContaining({ name: "thrash-guard", outcome: "suspend" }));
  });

  it("appends a nudge at the CURRENT turn and lets the turn go on", async () => {
    const deps = makeDeps({ kind: "nudge", reason: "r", firedBy: "open-steps", message: "keep going" });
    expect(await createTurnMiddlewarePhases(op(), 2, deps).beforeTurn()).toBeNull();
    expect(deps.appendNudgeAsUserMessage).toHaveBeenCalledWith(
      "op-phases", 2, "keep going", { name: "open-steps", reason: "r", outcome: "nudge" }, undefined);
  });
});

describe("afterModelCall", () => {
  it("hands the middlewares the live tool-call array and this turn's model signals", async () => {
    const deps = makeDeps();
    const call = modelCall();
    expect(await createTurnMiddlewarePhases(op(), 0, deps).afterModelCall(call)).toBeNull();
    const ctx = deps.contexts[0];
    expect(ctx.toolCalls).toBe(call.toolCalls);
    expect(deps.built[0]).toMatchObject({ assistantContent: "said" });
    expect(ctx).toMatchObject({ hasReasoning: true, modelEnded: true, completionTokens: 42 });
  });

  it("turns a nudge verdict into the sticky directive, keeping skipToolDispatch", async () => {
    const deps = makeDeps({ kind: "nudge", reason: "r", firedBy: "loop-detection", message: "m", skipToolDispatch: true });
    const directive = await createTurnMiddlewarePhases(op(), 0, deps).afterModelCall(modelCall());
    expect(directive).toEqual({ kind: "nudge", reason: "r", firedBy: "loop-detection", message: "m", metadata: undefined, skipToolDispatch: true });
  });

  it("falls back to the idle watchdog's suspend on a stalled worker lane only", async () => {
    const stalled = modelCall({ adapterError: { code: "stalled", message: "stuck", retryable: false } });
    const worker = await createTurnMiddlewarePhases(op("agent"), 0, makeDeps()).afterModelCall(stalled);
    expect(worker).toEqual({ kind: "suspend", reason: "idle-stalled", firedBy: "idle-watchdog", message: "stuck" });
    const interactive = await createTurnMiddlewarePhases(op("interactive"), 0, makeDeps()).afterModelCall(stalled);
    expect(interactive).toBeNull();
  });
});

describe("afterToolExecution", () => {
  it("builds the tool-results view and maps an abort verdict", async () => {
    const deps = makeDeps({ kind: "abort", reason: "r", firedBy: "repeat-failure", message: "stop" });
    const directive = await createTurnMiddlewarePhases(op(), 0, deps).afterToolExecution(modelCall(), [], []);
    expect(deps.buildToolResultsView).toHaveBeenCalledWith([], [], deps.extractToolResultText);
    expect(deps.runMiddlewarePhase).toHaveBeenCalledWith(expect.anything(), "afterToolExecution", []);
    expect(directive).toEqual({ kind: "abort", reason: "r", firedBy: "repeat-failure", message: "stop" });
  });

  it("composes every phase from the one per-turn composer", async () => {
    const deps = makeDeps();
    const phases = createTurnMiddlewarePhases(op(), 0, deps);
    await phases.beforeTurn();
    await phases.afterModelCall(modelCall());
    await phases.afterToolExecution(modelCall(), [], []);
    expect(deps.createTurnContextComposer).toHaveBeenCalledTimes(1);
  });
});

describe("directiveSkipsToolDispatch", () => {
  it("skips on an abort or a nudge that asked for it, never otherwise", () => {
    expect(directiveSkipsToolDispatch(null)).toBe(false);
    expect(directiveSkipsToolDispatch({ kind: "abort", reason: "r", firedBy: "x" })).toBe(true);
    expect(directiveSkipsToolDispatch({ kind: "nudge", reason: "r", firedBy: "x", message: "m" })).toBe(false);
    expect(directiveSkipsToolDispatch({ kind: "nudge", reason: "r", firedBy: "x", message: "m", skipToolDispatch: true })).toBe(true);
    expect(directiveSkipsToolDispatch({ kind: "suspend", reason: "r", firedBy: "x", message: "m" })).toBe(false);
  });
});
