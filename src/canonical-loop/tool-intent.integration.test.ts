// Incident 2026-09-08 replayed END TO END through the canonical loop.
// muse-glimmer:30b, after real tool steps, emitted its next grep call as
// TEXT (`<atem:function_calls><atem:invoke name="grep">…`) and the turn
// ended showing that block as the reply. Three fixes on three seams; this
// file proves they hold TOGETHER on the public loop surface (full-turn.test.ts'
// harness: canonicalLoopEntry → scheduler → worker → turn-loop, with only the
// per-op adapter and the tool dispatcher swapped), not just each in isolation.
//
// Which pre-campaign code each scenario catches:
//   A — d281d2e7 (one recognizer incl. namespaced `<atem:` tags) + fb247948
//       (text rescue in stream-once.ts applyToolCallTextFallback): before them
//       the incident block was never promoted, grep never dispatched, and the
//       block persisted as the reply text.
//   B — 0a44594c (tool-intent-gate.ts + its "unresolved-tool-intent" row in
//       decide-outcome-gates.ts): before it decideTurnOutcome let the turn end
//       "done" on the first leak — no nudge row, no honest terminal.
//   C — a91ed271 / 7191ce53 (output-sanitize pass 3 consuming the recognizer):
//       before them the persisted text kept the `<atem:` markup.
//   D — a7da547d (request-preflight.ts, verdict fits|too_big): before it the
//       openai-compat adapter's `fits_without_tools` branch sent the step with
//       `tools: []` — streamOnce called a 2nd time, tool-less, never refused.
//
// Nothing here depends on the adapter's prose-narration retry or the
// extractor's prose layer: A's block is SYNTAX and is promoted before any
// prose check could run; B never goes through the openai-compat adapter.
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "./adapter-contract.js";
import type { ToolCall, ToolDescriptor } from "./contract-types.js";
import type { Op } from "../ops/types.js";
import type { StreamOnceResult } from "./adapters/openai-compat/types.js";

// The ONE transport seam of the real openai-compat adapter. Everything else in
// stream-once.js (applyToolCallTextFallback → the extractor) stays real.
vi.mock("./adapters/openai-compat/stream-once.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/openai-compat/stream-once.js")>();
  return { ...actual, streamOnce: vi.fn() };
});
// The incident's MEASURED window; provenance under test control (D refuses
// only on a measured window — a floor window is a placeholder, never refused).
vi.mock("../context-manager/model-windows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context-manager/model-windows.js")>();
  const resolveContextWindow = vi.fn(() => ({ tokens: 65_536, provenance: "probed" as const }));
  return { ...actual, resolveContextWindow, lookupContextWindow: () => 65_536 };
});
// Loopback baseURLs trigger a live tool-capability probe after a turn; never
// send one from a test (openai-compat.tool-verify.test.ts pins the same).
vi.mock("../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));

// ops/event-log.ts and ops/op-store.ts bind OPS_BASE at import — isolate the
// data dir BEFORE the dynamic import below. LAX_LLM_COMPACTION=0 keeps
// build-input's compaction from calling a summarizer on D's oversized history.
const prevLaxDir = process.env.LAX_DATA_DIR;
const prevCompaction = process.env.LAX_LLM_COMPACTION;
const tmp = mkdtempSync(join(tmpdir(), "lax-tool-intent-"));
process.env.LAX_DATA_DIR = tmp;
process.env.LAX_LLM_COMPACTION = "0";
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  if (prevCompaction === undefined) delete process.env.LAX_LLM_COMPACTION;
  else process.env.LAX_LLM_COMPACTION = prevCompaction;
  rmSync(tmp, { recursive: true, force: true });
});

const {
  canonicalLoopEntry, registerAdapterForOp, setToolDispatcher, functionToolDispatcher,
  awaitCanonicalOp, awaitIdle, readOpMessages, resetCanonicalRuntime, resetScheduler, subscribeOpEvents,
} = await import("./index.js");
const { registerToolsForOp, unregisterToolsForOp } = await import("./runtime.js");
const { readOp } = await import("../ops/op-store.js");
const { createOpenAICompatAdapter } = await import("./adapters/openai-compat.js");
const { streamOnce } = await import("./adapters/openai-compat/stream-once.js");
const { WIRE_FORMAT_NUDGE } = await import("./turn-loop/nudges.js");
const { honestToolIntentTerminal } = await import("./turn-loop/tool-intent-gate.js");
const { sanitizeModelOutput } = await import("../providers/output-sanitize.js");
const { _resetMiddlewareStack } = await import("./middlewares/host.js");
const { OUTPUT_RESERVE_TOKENS } = await import("../context-manager/request-fit.js");

afterAll(() => {
  resetCanonicalRuntime();
  resetScheduler();
  _resetMiddlewareStack();
});

const mockStream = vi.mocked(streamOnce);
const MODEL = "muse-glimmer:30b";
const WINDOW = 65_536;
const INCIDENT_PATH = "workspace/apps/bellavida-medical-massage-clone";
/** The block muse-glimmer emitted as its final text, byte for byte. */
const INCIDENT_BLOCK =
  `<atem:function_calls>\n<atem:invoke name="grep">\n` +
  `<atem:parameter name="pattern">footer</atem:parameter>\n` +
  `<atem:parameter name="path">${INCIDENT_PATH}</atem:parameter>\n` +
  `<atem:parameter name="output_mode">content</atem:parameter>\n` +
  `</atem:invoke>\n</atem:function_calls>`;

/** The same block, UNPROMOTABLE: complete syntax naming a real tool, but the
 *  payload is over the extractor's MAX_ARGS_CHARS cap (256 KiB), so no seam
 *  may promote it — a truncated/over-cap call must never execute. Marker
 *  varies per leak so the two leaks are not byte-identical. */
function overCapBlock(marker: string): string {
  return (
    `<atem:function_calls>\n<atem:invoke name="grep">\n` +
    `<atem:parameter name="pattern">${marker}${"x".repeat(270_000)}</atem:parameter>\n` +
    `<atem:parameter name="path">${INCIDENT_PATH}</atem:parameter>\n` +
    `</atem:invoke>\n</atem:function_calls>`
  );
}

const CHAT_TOOLS: ToolDescriptor[] = [
  { name: "grep", description: "search file contents", inputSchema: { type: "object" } },
  { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
  { name: "bash", description: "run a shell command", inputSchema: { type: "object" } },
];

/** ~13k tokens of tool schemas — the incident manifest, as in tool-continuity. */
function incidentManifest(): ToolDescriptor[] {
  return Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: "d".repeat(1_050),
    inputSchema: { type: "object" },
  }));
}

function streamResult(over: Partial<StreamOnceResult>): StreamOnceResult {
  return {
    assembledText: "", assembledThinking: "", pendingToolCalls: [], firstError: null,
    providerStop: "stop", usagePromptTokens: 10, usageCompletionTokens: 5, interruptedByInject: false,
    ...over,
  };
}
function toolCallStep(id: string, name: string, args: string): StreamOnceResult {
  return streamResult({ pendingToolCalls: [{ id, name, arguments: args }], providerStop: "tool_calls" });
}
function textStep(text: string): StreamOnceResult {
  return streamResult({ assembledText: text });
}
/** Script the transport: each call pops the next step and, like the real
 *  streamOnce, reports every STRUCTURED tool call as tool_call_requested.
 *  A text step reports nothing — the text-rescue path (real, unmocked) does. */
function scriptTransport(steps: StreamOnceResult[]): void {
  mockStream.mockImplementation(async (_req, report) => {
    const step = steps.shift();
    if (!step) throw new Error("scripted transport exhausted — the loop sent a step the script never expected");
    for (const tc of step.pendingToolCalls) {
      report({ kind: "tool_call_requested", call: { toolCallId: tc.id, tool: tc.name, args: JSON.parse(tc.arguments) } });
    }
    return { ...step, pendingToolCalls: [...step.pendingToolCalls] };
  });
}

function makeOp(prefix: string, task: string): Op {
  return {
    id: `op-${prefix}-${randomUUID().slice(0, 8)}`,
    type: "freeform",
    task,
    contextPack: {
      task: { description: task, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 8, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    model: MODEL,
  };
}

function realAdapter(): Adapter {
  return createOpenAICompatAdapter({
    model: MODEL, baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama",
    systemPrompt: "s".repeat(500 * 3.5),
  });
}

/** Scripted adapter for B: leaks over-cap grep syntax as its final text on
 *  every turn, recording what history each turn was handed. */
function leakingAdapter(seen: TurnInput[]): Adapter {
  return {
    name: "fake-leaking", version: "1",
    async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      seen.push(input);
      report({
        kind: "message_finalized",
        message: { messageId: `am-leak-${input.turnIdx}`, role: "assistant", content: { text: overCapBlock(`leak${input.turnIdx}-`) } },
      });
      return { providerState: { adapterName: "fake-leaking", adapterVersion: "1", providerPayload: null }, terminalReason: "done", modelStop: "ended" };
    },
    async abort(): Promise<void> { /* scripted */ },
  };
}

function text(row: { content: unknown }): string {
  return (row.content as { text?: string }).text ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStream.mockReset(); // drop any script a prior scenario left unconsumed
});

describe("2026-09-08 tool-intent incident — the three seams hold together on the canonical loop", () => {
  it("A. adapter: after two real tool steps the incident block is promoted into a REAL grep call and never reaches the reply", async () => {
    const dispatch = vi.fn(async (call: ToolCall) => ({ status: "ok" as const, result: `ok:${call.tool}` }));
    setToolDispatcher(functionToolDispatcher(dispatch));
    scriptTransport([
      toolCallStep("c1", "read_file", '{"path":"index.html"}'),
      toolCallStep("c2", "read_file", '{"path":"styles.css"}'),
      textStep(INCIDENT_BLOCK), // tool_calls EMPTY — the incident step
      textStep("The footer is defined in index.html."),
    ]);

    const op = makeOp("incident-a", "find the footer in the bellavida clone");
    registerToolsForOp(op.id, CHAT_TOOLS);
    registerAdapterForOp(op.id, realAdapter);
    try {
      canonicalLoopEntry(op);
      const result = await awaitCanonicalOp(op.id, 10_000);
      expect(result?.status).toBe("completed");
      await awaitIdle(5_000);
      expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

      // Tools were offered on EVERY step, including the leak step and the one after.
      expect(mockStream).toHaveBeenCalledTimes(4);
      for (const [req] of mockStream.mock.calls) expect(req.tools.map(t => t.name)).toEqual(["grep", "read_file", "bash"]);

      // The leak was rescued into a real dispatch with the incident's arguments.
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(dispatch.mock.calls.map(([c]) => c.tool)).toEqual(["read_file", "read_file", "grep"]);
      expect(dispatch.mock.calls[2][0].args).toEqual({ pattern: "footer", path: INCIDENT_PATH, output_mode: "content" });

      // Transcript: the leak turn persisted as a tool-call row, then its result, then the real reply.
      const rows = readOpMessages(op.id);
      expect(rows.map(r => r.role)).toEqual([
        "user", "assistant", "tool_result", "assistant", "tool_result", "assistant", "tool_result", "assistant",
      ]);
      // (openai-compat persists tool calls in the wire shape: {id, name, arguments}.)
      const leakRow = rows[5].content as { text: string; toolCalls?: Array<{ name: string }> };
      expect(leakRow.toolCalls?.map(c => c.name)).toEqual(["grep"]);
      expect(leakRow.text).not.toContain("<atem:");
      expect(text(rows[7])).toBe("The footer is defined in index.html.");
      for (const row of rows) expect(JSON.stringify(row.content)).not.toContain("<atem:");
    } finally {
      unregisterToolsForOp(op.id);
    }
  }, 15_000);

  it("B. gate: an unpromotable leak re-opens the turn ONCE with WIRE_FORMAT_NUDGE; a second leak ends honestly, naming grep", async () => {
    setToolDispatcher(functionToolDispatcher(vi.fn(async () => ({ status: "ok" as const, result: "unused" }))));
    const seen: TurnInput[] = [];
    const op = makeOp("incident-b", "find the footer in the bellavida clone");
    registerToolsForOp(op.id, CHAT_TOOLS);
    registerAdapterForOp(op.id, () => leakingAdapter(seen));
    try {
      canonicalLoopEntry(op);
      const result = await awaitCanonicalOp(op.id, 10_000);
      expect(result?.status).toBe("completed");
      await awaitIdle(5_000);
      expect(readOp(op.id)?.canonical?.state).toBe("succeeded");

      // Exactly one re-open: two adapter turns, the second handed the nudge as
      // a USER message (build-input may append its ephemeral situational
      // digest to that trailing user row, so match the head, not the whole).
      expect(seen.map(s => s.turnIdx)).toEqual([0, 1]);
      const last = seen[1].messages[seen[1].messages.length - 1];
      expect(last.role).toBe("user");
      expect(text(last).startsWith(WIRE_FORMAT_NUDGE)).toBe(true);
      expect(seen[0].messages.some(m => text(m).includes("wire-format-error"))).toBe(false);

      const rows = readOpMessages(op.id);
      expect(rows.map(r => `${r.turnIdx}:${r.role}`)).toEqual([
        "0:user", "0:assistant", "1:user", "1:assistant", "1:assistant",
      ]);
      expect(rows[2].content).toMatchObject({ kind: "nudge", text: WIRE_FORMAT_NUDGE });
      // The honest terminal follows the model's own leaked message and names the tool.
      const honest = text(rows[4]);
      expect(honest).toBe(honestToolIntentTerminal("grep", 2));
      expect(honest).toContain("`grep`");
      expect(honest).toContain("Nothing was executed");
      expect(honest).not.toContain("<atem:");
      // Both leaks are still in the transcript untouched — scrubbing is C's seam.
      expect(text(rows[1])).toContain("<atem:invoke");
      expect(text(rows[3])).toContain("<atem:invoke");

      // C. persist: what the chat path stores (sanitizeModelOutput "persist")
      // keeps the honest message intact and drops every leaked block.
      expect(sanitizeModelOutput(honest, "persist")).toBe(honest);
      const persisted = rows.filter(r => r.role === "assistant").map(r => sanitizeModelOutput(text(r), "persist"));
      expect(persisted[2]).toBe(honest);
      for (const p of persisted) {
        expect(p).not.toContain("<atem:");
        expect(p).not.toContain("</atem:");
      }
      expect(persisted[0]).toBe("");
      expect(persisted[1]).toBe("");
    } finally {
      unregisterToolsForOp(op.id);
    }
  }, 15_000);

  it("D. budget: on the measured 65,536 window a step that no longer fits WITH its ~13k manifest is refused before send, never sent tool-less", async () => {
    const tools = incidentManifest();
    // One real step, then a tool result big enough that step 2's messages plus
    // system + manifest exceed the budget while system + messages alone fit —
    // exactly the zone the old adapter answered by stripping tools.
    const bigResult = "y".repeat(Math.floor((WINDOW - OUTPUT_RESERVE_TOKENS - 8_000) * 3.5));
    const dispatch = vi.fn(async () => ({ status: "ok" as const, result: bigResult }));
    setToolDispatcher(functionToolDispatcher(dispatch));
    scriptTransport([
      toolCallStep("c1", "tool_00", "{}"),
      textStep("must never be reached"),
    ]);

    const op = makeOp("incident-d", "help");
    registerToolsForOp(op.id, tools);
    registerAdapterForOp(op.id, realAdapter);
    const errors: Array<{ code: string; message: string }> = [];
    const off = subscribeOpEvents(op.id, e => {
      if (e.type === "error") errors.push(e.body as { code: string; message: string });
    });
    try {
      canonicalLoopEntry(op);
      const result = await awaitCanonicalOp(op.id, 10_000);
      await awaitIdle(5_000);
      expect(result?.status).toBe("failed");
      expect(readOp(op.id)?.canonical?.state).toBe("failed");
      // The refusal is the adapter's reported error, carrying the incident numbers.
      const refusal = errors.find(e => e.code === "context_window_exceeded");
      expect(refusal, `errors seen: ${JSON.stringify(errors)}`).toBeDefined();
      expect(refusal!.message).toContain("65,536");
      expect(refusal!.message).toMatch(/tools ~1[23],\d{3}/);

      // Only the first step was sent — with the whole manifest. The over-budget
      // step was refused at preflight; the old code sent it as call #2 with tools: [].
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0].tools).toHaveLength(40);
      const rows = readOpMessages(op.id);
      expect(rows.some(r => text(r).includes("must never be reached"))).toBe(false);
    } finally {
      off();
      unregisterToolsForOp(op.id);
    }
  }, 15_000);
});
