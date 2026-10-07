// A chat turn that ends by asking the user, through the REAL default
// middleware stack and completion gates.
//
// A friend's chat (2026-10-05) showed the agent ask the same question four times:
// the open-steps gate pushed again every time the model ticked a step off
// (bookkeeping, not progress), and the repeat-output breaker pushed a model
// that had ended its turn with words, so each push added another copy.
// And a question asked before any work skipped every gate: the classic way a
// model hands work back unstarted ("what style should the deck be?").
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../src/canonical-loop/turn-loop/build-verify.js", async (o) => ({
  ...(await o<typeof import("../src/canonical-loop/turn-loop/build-verify.js")>()),
  runBuildVerifyGate: vi.fn(async () => ({ nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "" })),
}));

import {
  canonicalLoopEntry, registerAdapterForOp, setToolDispatcher, functionToolDispatcher,
  awaitCanonicalOp, awaitIdle, readCanonicalEvents, resetCanonicalRuntime, resetScheduler,
} from "../src/canonical-loop/index.js";
import { enableDefaultMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { trackOpForSession } from "../src/ops/session-bridge.js";
import { newOpId } from "../src/ops/op-store.js";
import { taskTools, getOpenTasksForSession } from "../src/tools/task-tools.js";
import { askUserTool } from "../src/tools/ask-user-tool.js";
import type { Op } from "../src/ops/types.js";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../src/canonical-loop/adapter-contract.js";
import type { ToolCall } from "../src/canonical-loop/contract-types.js";

let currentOp = "";
const ps = { adapterName: "repro", adapterVersion: "1", providerPayload: null };

function mkOp(label: string, task: string): Op {
  const id = newOpId(`repro_${label}_${randomUUID().slice(0, 6)}`);
  return {
    id, type: "chat_turn", task,
    contextPack: { task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" }, capabilities: {},
      budget: { maxIterations: 10, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 }, routing: { lane: "interactive" }, secrets: { allowed: [] } },
    lane: "interactive", retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] }, ownerId: "local-user", visibility: "private",
    status: "pending", createdAt: new Date().toISOString(), attemptCount: 0, model: "fake",
  } as unknown as Op;
}

function scripted(turns: Array<{ text: string; calls?: ToolCall[] }>, seen: string[]): Adapter {
  return {
    name: "repro", version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      const t = turns[Math.min(input.turnIdx, turns.length - 1)];
      seen.push(`turn ${input.turnIdx}: ${t.calls?.map((c) => c.tool).join("+") || "(text only)"} | ${t.text.slice(0, 60)}`);
      for (const c of t.calls ?? []) report({ kind: "tool_call_requested", call: c });
      report({ kind: "message_finalized", message: { messageId: `m-${input.turnIdx}`, role: "assistant", content: t.calls ? { text: t.text, toolCalls: t.calls } : { text: t.text } } });
      return t.calls && t.calls.length > 0 ? { providerState: ps, modelStop: "continue" } : { providerState: ps, terminalReason: "done", modelStop: "ended" };
    },
    async abort() {},
  };
}

async function run(label: string, task: string, turns: Array<{ text: string; calls?: ToolCall[] }>, seedTasks = 0) {
  const op = mkOp(label, task);
  const session = `sess-${op.id}`;
  currentOp = op.id;
  trackOpForSession(op.id, session, task);
  const create = taskTools.find((t) => t.name === "task_create")!;
  for (let i = 0; i < seedTasks; i++) await create.execute({ id: `${op.id}-step-${i + 1}`, description: `Step ${i + 1} of the dashboard`, _sessionId: session });
  const seen: string[] = [];
  registerAdapterForOp(op.id, () => scripted(turns, seen));
  canonicalLoopEntry(op);
  await awaitCanonicalOp(op.id, 20_000);
  await awaitIdle(5_000);
  const events = readCanonicalEvents(op.id);
  const fires = events.filter((e) => e.type === "middleware_fired").map((e) => { const b = e.body as { name?: string; outcome?: string }; return `${b.name}/${b.outcome}`; });
  const texts = events.filter((e) => e.type === "message_appended" || e.type === "nudge_appended").map((e) => JSON.stringify(e.body).slice(0, 200));
  return { turns: seen.length, fires, texts: seen };
}

beforeEach(() => {
  enableDefaultMiddlewareStack();
  setToolDispatcher(functionToolDispatcher(async (call: ToolCall) => {
    if (call.tool === "task_update") {
      const upd = taskTools.find((t) => t.name === "task_update")!;
      const a = call.args as { id: string; status: string };
      await upd.execute({ ...a, id: a.id.replace("__STEP1__", `${currentOp}-step-1`) });
    }
    if (call.tool === "ask_user") {
      const r = await askUserTool.execute({ ...(call.args as object), _operationId: currentOp });
      return { status: (r.status === "blocked" ? "blocked" : "ok") as "ok", result: r.content };
    }
    return { status: "ok" as const, result: { ok: true } };
  }));
});
afterEach(async () => { await awaitIdle(3_000).catch(() => undefined); });
afterAll(() => { resetScheduler(); resetCanonicalRuntime(); });

const WRITE: ToolCall = { toolCallId: "w1", tool: "write", args: { path: "dashboard/index.html", content: "<h1>x</h1>" } };
const ASK: ToolCall = { toolCallId: "q1", tool: "ask_user", args: { question: "What style should the presentation use?" } };

const Q = "Which brokerage do you use, and what country/state are you in?";

describe("a turn that ends by asking the user", () => {
  it("is pushed once over open steps, not again after a ticked-off step, and the repeat breaker does not reopen it", async () => {
    const r = await run("friend", "Build me a trading dashboard", [
      { text: "Built the learning layer.", calls: [WRITE] },
      { text: Q },
      { text: Q, calls: [{ toolCallId: "u1", tool: "task_update", args: { id: "__STEP1__", status: "completed" } }] },
      { text: Q },
    ], 5);
    expect(r.fires).toEqual(["open-steps/nudge"]);
    expect(r.turns).toBe(4);
  }, 40_000);

  it("is pushed again after real work AND a step done since the last push (keep-going stays)", async () => {
    const r = await run("worked", "Build me a trading dashboard", [
      { text: "Built the learning layer.", calls: [WRITE] },
      { text: Q },
      { text: "Built the lessons page too.", calls: [{ ...WRITE, toolCallId: "w2" }, { toolCallId: "u2", tool: "task_update", args: { id: "__STEP1__", status: "completed" } }] },
      { text: Q },
      { text: Q },
    ], 5);
    expect(r.fires.filter((f) => f === "open-steps/nudge")).toHaveLength(2);
  }, 40_000);

  it("through ask_user before any work: not delivered, and the model builds instead", async () => {
    const r = await run("ppt", "Make me a PowerPoint about our Q3 results", [
      { text: "", calls: [ASK] },
      { text: "Built the deck in a clean default style.", calls: [WRITE] },
      { text: "Here is your deck: 8 slides in a clean blue style; tell me to change it." },
    ]);
    expect(r.turns).toBe(3);
    expect(r.texts[1]).toMatch(/write/);
  }, 40_000);

  it("through ask_user after real work: delivered, and the turn ends on it", async () => {
    const r = await run("after-work", "Build me a trading dashboard", [
      { text: "Built the learning layer.", calls: [WRITE] },
      { text: "", calls: [{ ...ASK, args: { question: Q } }] },
      { text: "(should never run)" },
    ]);
    expect(r.turns).toBe(2);
  }, 40_000);
});
