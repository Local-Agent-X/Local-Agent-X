/**
 * The done chunk's stop reason is the one the Responses API gave, mapped onto
 * the stop strings the canonical loop reads (model-stop.ts, cut-off-turn.ts).
 * It used to be "end_turn" on every turn, so a reply cut off at the output
 * limit read as a clean finish.
 */
import { describe, it, expect, vi } from "vitest";
import type { CodexStreamYield } from "../../codex-client/types.js";

const yields: { current: CodexStreamYield[] } = { current: [] };
vi.mock("../../codex-client/index.js", () => ({
  async *streamCodexResponse() { for (const y of yields.current) yield y; },
}));

import { CodexCliAdapter } from "./codex-cli.js";
import { STREAM_CLOSED_STOP, type ProviderRequest, type StreamChunk } from "../adapter/types.js";

async function doneStop(stopReason: string | undefined): Promise<string | undefined> {
  yields.current = [{ type: "done", usage: { inputTokens: 1, outputTokens: 1 }, reasoning: [], ...(stopReason ? { stopReason } : {}) }];
  const chunks: StreamChunk[] = [];
  const req = { apiKey: "k", model: "m", messages: [], systemPrompt: "s", tools: [] } as unknown as ProviderRequest;
  for await (const c of new CodexCliAdapter().stream(req)) chunks.push(c);
  const done = chunks.find((c) => c.type === "done") as { stopReason: string } | undefined;
  return done?.stopReason;
}

describe("CodexCliAdapter done stop reason", () => {
  it("a completed response is a clean end of turn", async () => {
    expect(await doneStop("completed")).toBe("end_turn");
  });

  it("an incomplete response keeps the API's reason", async () => {
    expect(await doneStop("max_output_tokens")).toBe("max_output_tokens");
  });

  it("a stream that ended without the API's terminal event says so", async () => {
    expect(await doneStop(undefined)).toBe(STREAM_CLOSED_STOP);
  });
});
