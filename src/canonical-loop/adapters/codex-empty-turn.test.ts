import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";
import type { CodexTransport } from "./codex-transport.js";
import type { TurnInput, AdapterReport } from "../adapter-contract.js";

function makeInput(): TurnInput {
  return { opId: "op-test", turnIdx: 0, messages: [], tools: [] };
}

// Stub transport that replays a fixed event list on every stream() call
// (the adapter re-streams on its truncation-recovery retries).
function transportYielding(events: Array<Record<string, unknown>>): CodexTransport {
  return {
    async *stream() {
      for (const e of events) yield e;
    },
  } as unknown as CodexTransport;
}

describe("CodexAdapter empty-turn handling", () => {
  it("surfaces an empty_response error instead of a silent done when the stream is empty", async () => {
    // Regression (2026-06-15): a rotated/expired ChatGPT OAuth session — the
    // user signed in on another device — makes the request return an EMPTY
    // stream, not a 401. Before the fix the adapter ran the truncation-
    // recovery retries, found nothing, and finished as a contentless `done`,
    // leaving the chat bubble spinning at "0 tokens" with no error. It must
    // now end the turn in error with an actionable "reconnect" message.
    const transport = transportYielding([{ type: "done" }]);
    const adapter = new CodexAdapter({ transport, model: "gpt-5.5" });
    const reports: AdapterReport[] = [];
    const result = await adapter.runTurn(makeInput(), (r) => reports.push(r));

    const err = reports.find((r) => r.kind === "error");
    expect(err).toBeDefined();
    expect((err as { code: string }).code).toBe("empty_response");
    expect((err as { message: string }).message).toMatch(/reconnect openai/i);
    expect(result.terminalReason).toBe("error");
  });

  it("does NOT fire empty_response when the model produced text", async () => {
    const transport = transportYielding([
      { type: "text", delta: "hello" },
      { type: "done" },
    ]);
    const adapter = new CodexAdapter({ transport, model: "gpt-5.5" });
    const reports: AdapterReport[] = [];
    const result = await adapter.runTurn(makeInput(), (r) => reports.push(r));

    expect(
      reports.some((r) => r.kind === "error" && (r as { code: string }).code === "empty_response"),
    ).toBe(false);
    expect(result.terminalReason).toBe("done");
  });
});
