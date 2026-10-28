/**
 * The Codex adapter reports an empty or cut-off turn as it came back and
 * leaves the re-drive to the turn loop: cut-off-turn.ts for a stop at the
 * output limit, empty-turn-termination.ts for a turn with nothing in it. It
 * used to re-run the turn itself, twice, with guidance that was never saved,
 * never charged to the nudge budget and reset every turn, and then raise
 * empty_response — so the turn loop's own handlers never saw a Codex turn.
 */
import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";
import type { CodexTransport } from "./codex-transport.js";
import type { TurnInput, AdapterReport } from "../adapter-contract.js";
import { STREAM_CLOSED_STOP } from "../../providers/adapter/types.js";

function makeInput(): TurnInput {
  return { opId: "op-test", turnIdx: 0, messages: [], tools: [] };
}

/** Replays a fixed event list and counts how many times it was streamed. */
function transportYielding(events: Array<Record<string, unknown>>): CodexTransport & { calls: number } {
  const t = {
    calls: 0,
    async *stream() {
      t.calls += 1;
      for (const e of events) yield e;
    },
  };
  return t as unknown as CodexTransport & { calls: number };
}

async function run(events: Array<Record<string, unknown>>) {
  const transport = transportYielding(events);
  const adapter = new CodexAdapter({ transport, model: "gpt-5.5" });
  const reports: AdapterReport[] = [];
  const result = await adapter.runTurn(makeInput(), (r) => reports.push(r));
  const stopReason = (result.providerState.providerPayload as { stopReason?: string }).stopReason;
  return { transport, reports, result, stopReason };
}

describe("CodexAdapter leaves empty and cut-off turns to the turn loop", () => {
  it("a stream that closed with no response is streamed once and reported with its stop, not as an error", async () => {
    const { transport, reports, result, stopReason } = await run([{ type: "done", stopReason: STREAM_CLOSED_STOP }]);
    expect(transport.calls).toBe(1);
    expect(reports.some((r) => r.kind === "error")).toBe(false);
    expect(result.terminalReason).toBe("done");
    expect(stopReason).toBe(STREAM_CLOSED_STOP);
  });

  it("a reply cut off at the output limit is streamed once and carries the stop the cut-off re-drive keys on", async () => {
    const { transport, reports, result, stopReason } = await run([{ type: "done", stopReason: "max_output_tokens" }]);
    expect(transport.calls).toBe(1);
    expect(reports.some((r) => r.kind === "error")).toBe(false);
    expect(stopReason).toBe("max_output_tokens");
    expect(result.modelStop).toBe("continue");
  });

  it("a turn with text finishes as done", async () => {
    const { transport, result } = await run([{ type: "text", delta: "hello" }, { type: "done", stopReason: "end_turn" }]);
    expect(transport.calls).toBe(1);
    expect(result.terminalReason).toBe("done");
    expect(result.modelStop).toBe("ended");
  });
});
