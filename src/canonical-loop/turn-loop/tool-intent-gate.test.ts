import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../runtime.js", () => ({ getToolsForOp: vi.fn(() => []) }));
// nudges.ts stays REAL so the wrapper's append path is the one under test;
// its two sinks are stubbed (the store would otherwise write ~/.lax rows).
vi.mock("../store.js", () => ({ appendOpMessage: vi.fn(), readOpMessages: vi.fn(() => []), readOpTurn: vi.fn() }));
vi.mock("../event-emitter.js", () => ({ emit: vi.fn(), emitErrorOnce: vi.fn() }));

import { runToolIntentGate, honestToolIntentTerminal } from "./tool-intent-gate.js";
import { COMPLETION_GATES } from "./decide-outcome-gates.js";
import { WIRE_FORMAT_NUDGE } from "./nudges.js";
import { findTextToolCallRanges } from "../adapters/tool-call-text-syntaxes.js";
import { appendOpMessage } from "../store.js";
import { getToolsForOp } from "../runtime.js";
import { _resetMiddlewareStates } from "../middlewares/state.js";
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolDescriptor } from "../adapter-contract.js";

const appended = vi.mocked(appendOpMessage);
const tools = vi.mocked(getToolsForOp);
const gate = COMPLETION_GATES.find(g => g.name === "unresolved-tool-intent")!;

/** The nudge rows the wrapper appended, as (opId, turnIdx, text, role). */
function nudges(): Array<[string, number, string, string]> {
  return appended.mock.calls.map(([row]) => [
    row.opId, row.turnIdx, (row.content as { text?: string }).text ?? "", row.role,
  ]);
}

function op(id: string): Op {
  return { id, type: "chat_turn", task: "t", lane: "interactive" } as unknown as Op;
}

/** The 2026-09-08 muse-glimmer:30b final text, verbatim in shape. */
const INCIDENT =
  "Let me search for that.\n" +
  '<atem:function_calls><atem:invoke name="grep"><atem:parameter name="pattern">TODO</atem:parameter>' +
  "</atem:invoke></atem:function_calls>";

/** A write call cut off mid-parameter — recognized syntax the extractor can never promote. */
const TRUNCATED_WRITE = '<atem:invoke name="write"><atem:parameter name="path">a.ts</atem:parameter><atem:parameter name="content">const x';

const READ_TOOL: ToolCall[] = [{ toolCallId: "t1", tool: "read", args: { path: "a.ts" } }];
const GREP_TOOL: ToolCall[] = [{ toolCallId: "t1", tool: "grep", args: { pattern: "TODO" } }];

function ctx(id: string, assistantText: string, toolCalls: ToolCall[] = [], turnIdx = 4) {
  return { op: op(id), turnIdx, toolCalls, assistantText };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMiddlewareStates();
  tools.mockReturnValue([{ name: "grep" }, { name: "bash" }, { name: "read" }, { name: "write" }] as unknown as ToolDescriptor[]);
});

describe("unresolved-tool-intent gate (wrapper in the completion-gate table)", () => {
  it("is registered in the table", () => {
    expect(gate).toBeDefined();
  });

  it("incident text with no dispatched call → re-opens once, nudging turn+1 with the canonical wire-format text", async () => {
    const out = await gate.evaluate(ctx("op-a", INCIDENT));
    expect(out).toEqual({ reopen: true });
    expect(nudges()).toEqual([["op-a", 5, WIRE_FORMAT_NUDGE, "user"]]);
    expect(WIRE_FORMAT_NUDGE.startsWith("<wire-format-error:")).toBe(true);
  });

  it("second fire on the same op → lets the turn end with an honest terminal naming the leaked tool and the count", async () => {
    await gate.evaluate(ctx("op-b", INCIDENT));
    appended.mockClear();
    const out = await gate.evaluate(ctx("op-b", INCIDENT, [], 6));
    expect(out.reopen).toBe(false);
    expect(out.honestTerminal?.text).toBe(honestToolIntentTerminal("grep", 2));
    expect(out.honestTerminal?.text).toContain("`grep`");
    expect(out.honestTerminal?.text).toContain("2 times");
    // The gate NAMES the fire appending this terminal earns; it does not record
    // it. decide-outcome mints it at the append, turn-loop banks it after the
    // commit — see guard-fire.ts bankEarnedFires.
    expect(out.honestTerminal?.fire).toEqual({
      name: "unresolved-tool-intent", reason: "unresolved-tool-intent", outcome: "honest-terminal",
    });
    expect(nudges()).toEqual([]);
  });

  it("a third fire (a later gate re-opened after the second) states the real count, never a stale 'twice'", async () => {
    await gate.evaluate(ctx("op-b3", INCIDENT));
    await gate.evaluate(ctx("op-b3", INCIDENT));
    const out = await gate.evaluate(ctx("op-b3", INCIDENT));
    expect(out.reopen).toBe(false);
    expect(out.honestTerminal?.text).toBe(honestToolIntentTerminal("grep", 3));
    expect(out.honestTerminal?.text).toContain("3 times");
  });

  it("clean prose → CONTINUE, no nudge, no state consumed", async () => {
    const out = await gate.evaluate(ctx("op-c", "The tree is clean; nothing else is pending."));
    expect(out).toEqual({ reopen: false });
    expect(nudges()).toEqual([]);
    // The op's single retry is still available: a later leak re-opens.
    const later = await gate.evaluate(ctx("op-c", INCIDENT));
    expect(later.reopen).toBe(true);
  });

  it("MIXED: a real dispatched `read` PLUS an unpromoted `write` leak left in the text → reopen (no dispatched-calls exemption)", async () => {
    // Premise: the leak is recognized syntax the extractor could not promote,
    // so it survives in the final text while the read was promoted and excised.
    const text = `Reading first.\n${TRUNCATED_WRITE}`;
    const ranges = findTextToolCallRanges(text, new Set(["read", "write"]));
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(r => !r.promoted)).toBe(true);

    const out = await gate.evaluate(ctx("op-d", text, READ_TOOL));
    expect(out).toEqual({ reopen: true });
    expect(nudges()).toEqual([["op-d", 5, WIRE_FORMAT_NUDGE, "user"]]);
  });

  it("any recognized range left in the final text is unresolved intent even beside a dispatched call of the same tool", async () => {
    const out = await gate.evaluate(ctx("op-d2", INCIDENT, GREP_TOOL));
    expect(out).toEqual({ reopen: true });
  });

  it("ops are independent — one op's spent retry does not touch another's", async () => {
    await gate.evaluate(ctx("op-e", INCIDENT));
    await gate.evaluate(ctx("op-e", INCIDENT));
    appended.mockClear();
    const out = await gate.evaluate(ctx("op-f", INCIDENT, [], 1));
    expect(out).toEqual({ reopen: true });
    expect(nudges()).toEqual([["op-f", 2, WIRE_FORMAT_NUDGE, "user"]]);
  });
});

describe("runToolIntentGate (decision half)", () => {
  it("first fire hands back the canonical nudge; second hands back the honest terminal and no nudge", () => {
    expect(runToolIntentGate(ctx("op-r", INCIDENT))).toEqual({ nudge: WIRE_FORMAT_NUDGE, shouldRetry: true });
    expect(runToolIntentGate(ctx("op-r", INCIDENT))).toEqual({
      nudge: "", shouldRetry: false, honestTerminal: honestToolIntentTerminal("grep", 2),
    });
  });

  it("honest terminal falls back to 'a tool' when no block carried a usable name", () => {
    // A lone closer is recognized syntax with no candidate — still a leak, no name.
    const text = "I'll look into it.\n</tool_call>";
    runToolIntentGate(ctx("op-g", text));
    const out = runToolIntentGate(ctx("op-g", text));
    expect(out.honestTerminal).toBe(honestToolIntentTerminal(null, 2));
    expect(out.honestTerminal).toContain("I tried to call a tool");
  });

  it("resolves the leaked name against the op's registered tools when possible", () => {
    tools.mockReturnValue([{ name: "grep_search" }] as unknown as ToolDescriptor[]);
    const text = '<tool_call>{"name":"grep_search","arguments":{"pattern":"x"}}</tool_call>';
    runToolIntentGate(ctx("op-h", text));
    expect(runToolIntentGate(ctx("op-h", text)).honestTerminal).toContain("`grep_search`");
  });

  it("MASKING: a backticked example is not a leak, and cannot name the honest terminal", () => {
    // Quoted syntax alone → nothing to resolve.
    const quoted = 'Use the form `<invoke name="write">…</invoke>` when you need a file written.';
    expect(runToolIntentGate(ctx("op-m0", quoted))).toEqual({ nudge: "", shouldRetry: false });
    // Quoted example BEFORE a real leak: the name lookup must see the same
    // masked text as the range verdict, so the terminal names grep, not write.
    const mixed = `${quoted}\n${INCIDENT}`;
    runToolIntentGate(ctx("op-m1", mixed));
    const out = runToolIntentGate(ctx("op-m1", mixed));
    expect(out.honestTerminal).toBe(honestToolIntentTerminal("grep", 2));
    expect(out.honestTerminal).not.toContain("`write`");
  });
});
