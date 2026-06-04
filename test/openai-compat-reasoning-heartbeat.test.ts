import { describe, expect, it, vi } from "vitest";
import type { AdapterReport } from "../src/canonical-loop/adapter-contract.js";

// Mock the shared OpenAI Chat Completions client so we can drive an exact
// event sequence. Grok-4.3's failure mode (live 2026-06-04 dream stall):
// a turn that streams chain-of-thought into `reasoning_content` for minutes
// before emitting any `content` or tool_call. Those deltas surface as
// `thinking` events here.
const streamMock = vi.fn();
vi.mock("../src/providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: (...a: unknown[]) => streamMock(...a) },
}));

const { streamOnce } = await import("../src/canonical-loop/adapters/openai-compat/stream-once.js");

function makeStream(events: Record<string, unknown>[]) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

const req = { apiKey: "k", baseURL: "https://api.x.ai/v1", model: "grok-4.3", messages: [], tools: [] } as never;

describe("openai-compat reasoning heartbeat", () => {
  it("emits a heartbeat per reasoning delta so the idle watchdog stays alive", async () => {
    streamMock.mockReturnValue(makeStream([
      { type: "thinking", delta: "let me think " },
      { type: "thinking", delta: "about this " },
      { type: "thinking", delta: "some more" },
      { type: "done", stopReason: "stop" },
    ])());

    const reports: AdapterReport[] = [];
    const out = await streamOnce(req, (r) => reports.push(r), { isAborted: () => false });

    const heartbeats = reports.filter((r) => r.kind === "heartbeat");
    expect(heartbeats).toHaveLength(3); // one per reasoning delta → watchdog never trips

    // Per-delta thoughts are NOT streamed live to chat — heartbeats carry no
    // payload. The reasoning is buffered and only surfaced once at end-of-turn
    // as a fallback, since the model never emitted a `content` answer.
    expect(out.assembledThinking).toBe("let me think about this some more");
    expect(out.assembledText).toBe("let me think about this some more");
  });

  it("does not emit heartbeats when the model streams normal content", async () => {
    streamMock.mockReturnValue(makeStream([
      { type: "text", delta: "hello " },
      { type: "text", delta: "world" },
      { type: "done", stopReason: "stop" },
    ])());

    const reports: AdapterReport[] = [];
    await streamOnce(req, (r) => reports.push(r), { isAborted: () => false });

    expect(reports.filter((r) => r.kind === "heartbeat")).toHaveLength(0);
    expect(reports.filter((r) => r.kind === "stream_chunk")).toHaveLength(2);
  });
});
