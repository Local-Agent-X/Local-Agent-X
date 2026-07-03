import { describe, it, expect, vi } from "vitest";

// CT-1 — terminal error/done on the canonical throw path must reach WS clients.
//
// The bug: runCanonicalChat's catch path emitted the mid-turn error and the
// terminal `done` via `emitSse`. On a WS client the SSE sink is null, so
// emitSse is a no-op and BOTH events vanish — yet the function still returned
// doneEmitted:true, which suppresses the orchestrator's failChat safety net.
// The ActiveChat was therefore never marked done and the UI spun until the 60s
// watchdog. The fix routes both terminal events through `wrappedOnEvent`, which
// drives wsChat.onEvent (whose `done` handler clears the ActiveChat) — exactly
// what the success path already does.

// runChatViaCanonical throws synchronously → drive the catch path.
vi.mock("../src/canonical-loop/index.js", () => ({
  runChatViaCanonical: () => {
    throw new Error("provider exploded mid-stream");
  },
}));

import { runCanonicalChat } from "../src/routes/chat/run-chat-turn/canonical-run.js";

describe("runCanonicalChat — terminal error/done reach WS clients on the throw path", () => {
  it("emits terminal error+done via wrappedOnEvent (not the null-on-WS emitSse)", async () => {
    const wrapped: Array<{ type: string }> = [];
    const sse: Array<{ type: string }> = [];
    const controller = new AbortController(); // not aborted → provider error, not user-stop

    const input = {
      message: "do a thing",
      sessionId: "sess-ct1-throw",
      prepared: { model: "test-model", images: [] },
      sessionTools: [],
      session: { messages: [], updatedAt: 0 },
      ctx: { saveSession: vi.fn(), memoryManager: { persistTurn: vi.fn(async () => {}) } },
      requestRole: "owner",
      threatEngine: {},
      abortSignal: controller.signal,
      primaryEventProxy: () => {},
      wrappedOnEvent: (ev: { type: string }) => wrapped.push(ev),
      emitSse: (ev: { type: string }) => sse.push(ev),
      getFullResponseText: () => "",
    } as never;

    const result = await runCanonicalChat(input);

    // Both terminal events go through wrappedOnEvent (drives wsChat → clears the
    // ActiveChat). Pre-fix these went to emitSse and never reached a WS client.
    expect(wrapped.some((e) => e.type === "error")).toBe(true);
    const errorIdx = wrapped.findIndex((e) => e.type === "error");
    const doneIdx = wrapped.findIndex((e) => e.type === "done");
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    // error must precede done.
    expect(errorIdx).toBeLessThan(doneIdx);

    // Nothing terminal leaked to the SSE-only sink (it's the null path on WS).
    expect(sse.some((e) => e.type === "error" || e.type === "done")).toBe(false);

    // Still reports done so the orchestrator doesn't double-emit — but now `done`
    // was genuinely delivered through the channel that marks the chat complete.
    expect(result.doneEmitted).toBe(true);
  });
});
