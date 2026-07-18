// dispatchTools batch lane (C2): when the op's dispatcher exposes
// dispatchBatch, the whole tool_call_requested list rides ONE
// executeToolCalls invocation so tool-execution's EXISTING batcher decides
// what runs parallel vs serial. These tests drive the full real path —
// dispatchTools → makeChatToolDispatcher.dispatchBatch → executeToolCalls —
// with fake tools, and prove:
//   - parallel-safe tools actually OVERLAP in time (the per-call loop
//     serialized them; a revert re-serializes and fails the overlap test),
//   - a non-flagged tool stays strictly serialized behind the batch,
//   - per-call statuses and ORIGINAL call order survive the batch,
//   - tool_started/tool_finished events keep the per-call vocabulary,
//   - the tool_search augmentation side-effect still fires on the batch path,
//   - a dispatcher WITHOUT dispatchBatch still works via the per-call loop.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { dispatchTools } from "./dispatch-tools.js";
import { makeChatToolDispatcher } from "../chat-tool-dispatcher.js";
import {
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
  unregisterToolsForOp,
  getToolsForOp,
} from "../runtime.js";
import { functionToolDispatcher } from "../tool-dispatch.js";
import { getBus, eventsChannel } from "../bus.js";
import { setAriRequired } from "../../ari-kernel/state.js";
import { unifiedRegistry } from "../../tools/registry.js";
import { err } from "../../tools/result-helpers.js";
import type { CanonicalEvent } from "../types.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const trackedOpIds: string[] = [];
let seq = 0;
function freshOpId(): string { return `op_dispatch_batch_test_${seq++}_${process.pid}`; }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Legacy-envelope fake tool; flags control parallel-safety in executeToolCalls. */
function fakeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<ToolResult>,
  flags?: { readOnly?: boolean; concurrencySafe?: boolean },
): ToolDefinition {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute,
    ...flags,
  } as unknown as ToolDefinition;
}

function registerChatDispatcher(opId: string, tools: ToolDefinition[]): void {
  registerToolDispatcherForOp(opId, makeChatToolDispatcher({
    tools,
    security: undefined as never,
    sessionId: `s-${opId}`,
    callContext: "local",
    opId,
  }));
}

function trackOp(opId: string): string {
  trackedOpIds.push(opId);
  return opId;
}

function call(toolCallId: string, tool: string, args: unknown = {}): ToolCall {
  return { toolCallId, tool, args };
}

/** Collect canonical events for an op off the in-process bus. */
function collectEvents(opId: string): { events: CanonicalEvent[]; stop: () => void } {
  const events: CanonicalEvent[] = [];
  const stop = getBus().subscribe(eventsChannel(opId), (msg) => {
    events.push(msg as CanonicalEvent);
  });
  return { events, stop };
}

describe("dispatchTools batch lane through the real executeToolCalls batcher", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => {
    setAriRequired(true);
    for (const id of trackedOpIds) {
      const dir = join(OPS_BASE, id);
      if (existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });
  afterEach(() => {
    for (const id of trackedOpIds) {
      unregisterToolDispatcherForOp(id);
      unregisterToolsForOp(id);
    }
  });

  it("two parallel-safe tools OVERLAP in time and results return in input order", async () => {
    const opId = trackOp(freshOpId());
    // gate resolves only when tool B starts. If the calls were serialized
    // (the pre-C2 behavior), A would sit on the gate until its 1500ms escape
    // fires — flagging serialized=true and failing the assertion.
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    let serialized = false;

    const toolA = fakeTool("peek_a", async () => {
      await Promise.race([gate, sleep(1500).then(() => { serialized = true; })]);
      return { content: "A_DONE", isError: false };
    }, { readOnly: true });
    const toolB = fakeTool("peek_b", async () => {
      releaseGate();
      return { content: "B_DONE", isError: false };
    }, { concurrencySafe: true });

    registerChatDispatcher(opId, [toolA, toolB]);
    const out = await dispatchTools(opId, 0, [call("c-a", "peek_a"), call("c-b", "peek_b")]);

    expect(serialized).toBe(false); // they truly ran concurrently
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string }).toolCallId))
      .toEqual(["c-a", "c-b"]); // original call order, not completion order
    expect(out.toolSummary.map(s => s.tool)).toEqual(["peek_a", "peek_b"]);
    expect(out.toolSummary.every(s => s.resultStatus === "ok")).toBe(true);
    const texts = out.toolMessages.map(m => (m.content as { result: unknown }).result);
    expect(texts).toEqual(["A_DONE", "B_DONE"]);
  });

  it("a non-flagged tool is strictly serialized behind a parallel-safe one", async () => {
    const opId = trackOp(freshOpId());
    const order: string[] = [];
    const safe = fakeTool("safe_read", async () => {
      order.push("safe:start");
      await sleep(50);
      order.push("safe:end");
      return { content: "SAFE", isError: false };
    }, { readOnly: true });
    const bashish = fakeTool("fake_bash", async () => {
      order.push("bash:start");
      return { content: "BASH", isError: false };
    }); // no readOnly/concurrencySafe → parallel-unsafe

    registerChatDispatcher(opId, [safe, bashish]);
    const out = await dispatchTools(opId, 0, [call("c-1", "safe_read"), call("c-2", "fake_bash")]);

    // fake_bash must not start until safe_read fully resolved.
    expect(order).toEqual(["safe:start", "safe:end", "bash:start"]);
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string }).toolCallId))
      .toEqual(["c-1", "c-2"]);
  });

  it("per-call statuses survive the batch: one ok + one error, correct tool_finished events", async () => {
    const opId = trackOp(freshOpId());
    const good = fakeTool("good_tool", async () => ({ content: "FINE", isError: false }), { readOnly: true });
    const bad = fakeTool("bad_tool", async () => err("boom"), { readOnly: true });

    registerChatDispatcher(opId, [good, bad]);
    const { events, stop } = collectEvents(opId);
    try {
      const out = await dispatchTools(opId, 3, [call("c-ok", "good_tool"), call("c-err", "bad_tool")]);

      expect(out.toolSummary.map(s => [s.tool, s.resultStatus])).toEqual([
        ["good_tool", "ok"],
        ["bad_tool", "error"],
      ]);
      expect(out.toolMessages.map(m => (m.content as { status: string }).status))
        .toEqual(["ok", "error"]);

      // Event vocabulary preserved: tool_started per call BEFORE the batch,
      // tool_finished per call after, with the per-call status.
      const started = events.filter(e => e.type === "tool_started");
      const finished = events.filter(e => e.type === "tool_finished");
      expect(started.map(e => (e.body as { tool: string }).tool)).toEqual(["good_tool", "bad_tool"]);
      expect(finished.map(e => [
        (e.body as { tool: string }).tool,
        (e.body as { status: string }).status,
      ])).toEqual([["good_tool", "ok"], ["bad_tool", "error"]]);
      // Both starts precede both finishes (batch semantics).
      const seqOf = (e: CanonicalEvent) => e.seq;
      expect(Math.max(...started.map(seqOf))).toBeLessThan(Math.min(...finished.map(seqOf)));
    } finally {
      stop();
    }
  });

  it("tool_search augmentation still fires when tool_search rides the batch path", async () => {
    const opId = trackOp(freshOpId());
    const augTarget = fakeTool("aug_target_tool_c2", async () => ({ content: "unused", isError: false }));
    unifiedRegistry.register(augTarget);
    try {
      // Legacy envelope, content is the JSON array tool_search emits — the
      // shape augmentFromToolSearch parses.
      const search = fakeTool("tool_search", async () => (
        { content: JSON.stringify([{ name: "aug_target_tool_c2" }]), isError: false }
      ), { readOnly: true });
      const other = fakeTool("peek_other", async () => ({ content: "OK", isError: false }), { readOnly: true });

      registerChatDispatcher(opId, [search, other]);
      const out = await dispatchTools(opId, 0, [call("c-s", "tool_search"), call("c-o", "peek_other")]);

      expect(out.toolSummary.map(s => s.resultStatus)).toEqual(["ok", "ok"]);
      expect(getToolsForOp(opId).map(t => t.name)).toContain("aug_target_tool_c2");
    } finally {
      unifiedRegistry.unregister("aug_target_tool_c2");
    }
  });

  it("a dispatcher WITHOUT dispatchBatch falls back to the per-call loop", async () => {
    const opId = trackOp(freshOpId());
    const dispatched: string[] = [];
    registerToolDispatcherForOp(opId, functionToolDispatcher(async (c) => {
      dispatched.push(c.tool);
      return { status: "ok", result: `ran:${c.tool}` };
    }));

    const out = await dispatchTools(opId, 0, [call("c-1", "one"), call("c-2", "two")]);

    expect(dispatched).toEqual(["one", "two"]);
    expect(out.toolMessages.map(m => (m.content as { toolCallId: string; result: unknown }).result))
      .toEqual(["ran:one", "ran:two"]);
    expect(out.toolSummary.map(s => s.resultStatus)).toEqual(["ok", "ok"]);
  });
});
