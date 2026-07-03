import { describe, it, expect, vi, beforeEach } from "vitest";
import { processFrame, streamViaWarmPool, type FrameContext } from "./stream-prompt.js";
import type { StreamEvent } from "../types.js";
import type { WarmProcess } from "./types.js";

// Mocks for the release-vs-evict decision the finally block makes. These are
// hoisted above the module-under-test import so ./pool.js and the kill helper
// are intercepted before stream-prompt.ts binds them.
const { acquireMock, releaseSpy, killSpy } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  releaseSpy: vi.fn(),
  killSpy: vi.fn(),
}));
vi.mock("./pool.js", () => ({ acquire: acquireMock, release: releaseSpy }));
vi.mock("../../process-tree-kill.js", () => ({ killProcessTree: killSpy }));

// Build a closure-backed FrameContext like streamViaWarmPool's inner loop does,
// so the stop_reason capture (set on a stream_event/result, read when the done
// event is built) round-trips exactly as it does in production.
function makeCtx(over: Partial<FrameContext> = {}): FrameContext {
  let stop: string | undefined;
  let full = "";
  return {
    getAborted: () => false,
    getFullText: () => full,
    appendText: (t) => { full += t; },
    setUsage: () => {},
    getStopReason: () => stop,
    setStopReason: (s) => { stop = s; },
    ...over,
  };
}

function drain(frames: Record<string, unknown>[], ctx: FrameContext): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const f of frames) for (const ev of processFrame(f, ctx)) events.push(ev);
  return events;
}

const doneOf = (events: StreamEvent[]) => events.find((e) => e.type === "done");

describe("warm-pool processFrame — stop_reason is carried into the done event", () => {
  it("the result frame's top-level stop_reason reaches the done event", () => {
    const events = drain(
      [{ type: "result", result: "4", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }],
      makeCtx(),
    );
    expect(doneOf(events)!.stopReason).toBe("end_turn");
  });

  it("a message_delta frame captures stop_reason for the later result frame", () => {
    const ctx = makeCtx();
    const events = drain(
      [
        { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
        { type: "result", result: "x" },
      ],
      ctx,
    );
    expect(ctx.getStopReason()).toBe("tool_use");
    expect(doneOf(events)!.stopReason).toBe("tool_use");
  });

  it("done event has undefined stopReason when the CLI never reported one", () => {
    const events = drain([{ type: "result", result: "hi" }], makeCtx());
    expect(doneOf(events)!.stopReason).toBeUndefined();
  });
});

describe("warm-pool processFrame — tool routing (unchanged)", () => {
  const assistantToolUse = (name: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name, input: { q: "x" } }] },
  });

  it("a non-MCP tool_use yields a tool_call the outer loop dispatches", () => {
    const events = drain([assistantToolUse("web_search")], makeCtx());
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeDefined();
    expect((call as { name: string }).name).toBe("web_search");
  });

  it("an mcp__ tool_use stays bridge-routed activity, not a tool_call", () => {
    const events = drain([assistantToolUse("mcp__lax__web_search")], makeCtx());
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "mcp_activity")).toBe(true);
  });
});

describe("warm-pool processFrame — an errored result frame is an error, not text", () => {
  it("an is_error result yields an `error` event and no text with the message", () => {
    // Same class of bug as the cold-spawn seam: a logged-out CLI's is_error
    // result must not have its "Please run /login" text yielded as model
    // content (it was being persisted as a compaction summary).
    const events = drain(
      [{ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" }],
      makeCtx(),
    );
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain("Please run /login");
    expect(events.some((e) => e.type === "text")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("a successful result frame (is_error false) still yields done", () => {
    const events = drain([{ type: "result", is_error: false, result: "hi" }], makeCtx());
    expect(doneOf(events)).toBeDefined();
  });
});

describe("streamViaWarmPool — mid-turn bail evicts instead of pooling", () => {
  function fakeWp(): WarmProcess {
    return {
      proc: { stdin: { write: vi.fn() } },
      key: "m::plan::shared",
      state: "busy",
      lastUsedAt: 0,
      spawnedAt: 0,
      activeListener: null,
      buffer: "",
      stderr: "",
      mcpConfigPath: null,
    } as unknown as WarmProcess;
  }

  // Flush all pending microtasks so the generator reaches its await-frame
  // suspend point (activeListener installed, prompt written to stdin).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const textFrame = (t: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
  });

  beforeEach(() => {
    acquireMock.mockReset();
    releaseSpy.mockReset();
    killSpy.mockReset();
  });

  it("evicts a still-generating process when the consumer breaks before the result frame", async () => {
    // This is PR-4: on inject/stop the transport consumer .return()s this
    // generator mid-turn. If the process were pooled here, the next acquirer
    // would receive this turn's remaining frames — whose result frame ends
    // the new turn instantly (model appears to ignore the inject).
    const wp = fakeWp();
    acquireMock.mockResolvedValue(wp);
    const gen = streamViaWarmPool({ model: "m", permissionMode: "plan" }, { prompt: "hi" });

    const firstP = gen.next();
    await flush();
    expect((wp.proc.stdin.write as ReturnType<typeof vi.fn>)).toHaveBeenCalled();

    // Deliver ONE mid-turn text frame; the `result` frame never comes.
    wp.activeListener!(textFrame("partial"));
    const first = await firstP;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text", delta: "partial" });

    // Consumer bails (course-correction) → generator return runs the finally.
    await gen.return(undefined as never);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0][0]).toBe(wp.proc);
    expect(wp.state).toBe("dead");
    expect(releaseSpy).toHaveBeenCalledWith(wp);
  });

  it("returns a fully-completed turn's process to the pool without killing it", async () => {
    // Guard against an over-broad fix: a turn that reached its result frame
    // finished cleanly and MUST stay warm for reuse.
    const wp = fakeWp();
    acquireMock.mockResolvedValue(wp);
    const gen = streamViaWarmPool({ model: "m", permissionMode: "plan" }, { prompt: "hi" });

    const firstP = gen.next();
    await flush();

    wp.activeListener!({ type: "result", result: "", stop_reason: "end_turn" });
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "done" });

    const end = await gen.next();
    expect(end.done).toBe(true);

    expect(killSpy).not.toHaveBeenCalled();
    expect(wp.state).not.toBe("dead");
    expect(releaseSpy).toHaveBeenCalledWith(wp);
  });
});
