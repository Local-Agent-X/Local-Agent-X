/**
 * Codex keeps a turn's encrypted reasoning items on the assistant row and
 * sends them back on the next step of the same tool loop. Checked live on the
 * ChatGPT subscription endpoint (store:false) on 2026-11-13: the replayed item
 * was accepted and the step completed; without it the step completes too.
 */
import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";
import type { CodexTransport, CodexTransportRequest } from "./codex-transport.js";
import { toOaiMessage } from "./codex-transport.js";
import { convertMessagesToInput } from "../../codex-message-convert.js";
import type { AdapterReport, TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";

const item = { type: "reasoning", id: "rs_1", encrypted_content: "ENC" };

function transport(events: Array<Record<string, unknown>>, seen: CodexTransportRequest[]): CodexTransport {
  return { async *stream(req: CodexTransportRequest) { seen.push(req); for (const e of events) yield e as never; } } as CodexTransport;
}

const user: CanonicalMessage = { messageId: "u1", role: "user", content: { text: "go" } };

async function run(messages: CanonicalMessage[], events: Array<Record<string, unknown>>) {
  const seen: CodexTransportRequest[] = [];
  const reports: AdapterReport[] = [];
  const adapter = new CodexAdapter({ transport: transport(events, seen), model: "gpt-6.1-sol" });
  await adapter.runTurn({ opId: "op", turnIdx: 0, messages, tools: [] } as unknown as TurnInput, (r) => reports.push(r));
  const fin = reports.find((r) => r.kind === "message_finalized");
  return { seen, row: fin?.kind === "message_finalized" ? fin.message : undefined };
}

describe("Codex reasoning replay", () => {
  it("keeps the turn's reasoning items on the assistant row", async () => {
    const { row } = await run([user], [
      { type: "tool_call", id: "c1", name: "read", arguments: "{}" },
      { type: "done", stopReason: "completed", reasoningItems: [item] },
    ]);
    expect((row?.content as { reasoningPayload?: unknown }).reasoningPayload).toEqual({ provider: "codex", model: "gpt-6.1-sol", data: [item] });
  });

  it("sends them back with the row on the next step", async () => {
    const { row } = await run([user], [
      { type: "tool_call", id: "c1", name: "read", arguments: "{}" },
      { type: "done", stopReason: "completed", reasoningItems: [item] },
    ]);
    const toolRow: CanonicalMessage = { messageId: "t1", role: "tool_result", content: { toolCallId: "c1", result: "ok" } };
    const { seen } = await run([user, row!, toolRow], [{ type: "done", stopReason: "completed" }]);
    const assistant = seen[0].messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoningPayload).toEqual([item]);
    // On the wire: the reasoning item precedes the row's function call.
    const input = convertMessagesToInput(seen[0].messages.map(toOaiMessage)) as Array<{ type: string }>;
    expect(input.map((i) => i.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
  });

  it("does not send them to a different Codex model", async () => {
    const { row } = await run([user], [
      { type: "tool_call", id: "c1", name: "read", arguments: "{}" },
      { type: "done", stopReason: "completed", reasoningItems: [item] },
    ]);
    const seen: CodexTransportRequest[] = [];
    const other = new CodexAdapter({ transport: transport([{ type: "done" }], seen), model: "gpt-5.6-sol" });
    await other.runTurn({ opId: "op", turnIdx: 1, messages: [user, row!], tools: [] } as unknown as TurnInput, () => {});
    expect(seen[0].messages.find((m) => m.role === "assistant")?.reasoningPayload).toBeUndefined();
  });
});
