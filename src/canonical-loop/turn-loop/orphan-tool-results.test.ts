import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared logger stub so a test can read the synthesized-row info lines.
vi.mock("../../logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => logger };
});

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import {
  appendMissingToolResults,
  DISPATCH_SKIPPED_CODE,
  MISSING_TOOL_RESULT_TEXT,
  type SynthesizedToolResultContent,
} from "./orphan-tool-results.js";
import { createLogger } from "../../logger.js";
import { MISSING_TOOL_OUTPUT, convertMessagesToInput } from "../../codex-message-convert.js";
import { convertMessages } from "../../anthropic-client/request.js";
import { canonicalToTransport } from "../adapters/canonical-to-transport.js";
import type { TransportMessage } from "../adapters/anthropic.js";
import { opMessageRowToChatParam } from "../chat-runner/message-convert.js";
import { classifyStepEffort } from "../step-effort.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { OpMessageRow } from "../types.js";

const log = createLogger("test") as unknown as { info: ReturnType<typeof vi.fn> };

const SKIPPED_BY = { firedBy: "loop-detection", reason: "strategy-pivot" };

// The shape every adapter finalizes on an assistant row (anthropic.ts /
// codex.ts / openai-compat.ts): `content.toolCalls: [{ id, name, arguments }]`.
function assistantRow(calls: Array<{ id: string; name: string }>, text = ""): CommitTurnMessage {
  return {
    messageId: "am1",
    role: "assistant",
    content: { text, toolCalls: calls.map(c => ({ ...c, arguments: "{}" })) },
  };
}
// The shape dispatch-tools.ts commits for a real result.
function realRow(toolCallId: string, result = "[ok]\ndone\n"): CommitTurnMessage {
  return { role: "tool_result", content: { toolCallId, result, status: "ok" } };
}
function synthesized(toolCallId: string): SynthesizedToolResultContent {
  return {
    toolCallId,
    result: MISSING_TOOL_RESULT_TEXT,
    status: "error",
    synthesized: { code: DISPATCH_SKIPPED_CODE, middleware: "loop-detection", reason: "strategy-pivot" },
  };
}
const TWO_CALLS = [
  { id: "call-a", name: "calendar_create_event" },
  { id: "call-b", name: "bash" },
];

describe("appendMissingToolResults — the commit-seam invariant", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers every unanswered call on the assistant row, in call order, with the exact text/status/metadata", () => {
    const messages = [assistantRow(TWO_CALLS)];
    expect(appendMissingToolResults(messages, SKIPPED_BY)).toBe(2);
    expect(messages.map(m => m.role)).toEqual(["assistant", "tool_result", "tool_result"]);
    expect(messages[1].content).toEqual(synthesized("call-a"));
    expect(messages[2].content).toEqual(synthesized("call-b"));
    // No messageId — commitTurn mints one, exactly as it does for dispatched rows.
    expect(messages[1].messageId).toBeUndefined();
  });

  it("leaves a fully answered turn untouched — same rows, same references, nothing logged", () => {
    const rows = [assistantRow(TWO_CALLS), realRow("call-a"), realRow("call-b")];
    const messages = [...rows];
    expect(appendMissingToolResults(messages, SKIPPED_BY)).toBe(0);
    expect(messages).toHaveLength(3);
    rows.forEach((row, i) => expect(messages[i]).toBe(row));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("answers only the missing call of a partially answered batch", () => {
    const messages = [assistantRow(TWO_CALLS), realRow("call-a")];
    expect(appendMissingToolResults(messages, SKIPPED_BY)).toBe(1);
    expect(messages).toHaveLength(3);
    expect((messages[2].content as SynthesizedToolResultContent).toolCallId).toBe("call-b");
  });

  it("logs one info line per synthesized row in the pinned format", () => {
    appendMissingToolResults([assistantRow(TWO_CALLS)], SKIPPED_BY);
    expect(log.info.mock.calls.map(c => c[0])).toEqual([
      "[canonical-loop] synthesized tool_result for calendar_create_event (call-a): dispatch skipped by loop-detection",
      "[canonical-loop] synthesized tool_result for bash (call-b): dispatch skipped by loop-detection",
    ]);
  });

  it("without a directive the provenance is 'unknown' and carries no reason", () => {
    const messages = [assistantRow([{ id: "call-a", name: "bash" }])];
    appendMissingToolResults(messages, null);
    expect((messages[1].content as SynthesizedToolResultContent).synthesized)
      .toEqual({ code: "dispatch_skipped", middleware: "unknown" });
    expect(log.info).toHaveBeenCalledWith(
      "[canonical-loop] synthesized tool_result for bash (call-a): dispatch skipped by unknown",
    );
  });

  it("skips malformed entries (no string id) and labels a nameless call 'unknown' in the log only", () => {
    const messages: CommitTurnMessage[] = [{
      messageId: "am1",
      role: "assistant",
      content: { text: "", toolCalls: [{ name: "bash" }, null, "x", { id: "call-z" }] },
    }];
    expect(appendMissingToolResults(messages, SKIPPED_BY)).toBe(1);
    expect((messages[1].content as SynthesizedToolResultContent).toolCallId).toBe("call-z");
    expect(log.info).toHaveBeenCalledWith(
      "[canonical-loop] synthesized tool_result for unknown (call-z): dispatch skipped by loop-detection",
    );
  });

  it("ignores rows with no toolCalls and text-only assistant rows", () => {
    const messages: CommitTurnMessage[] = [
      { role: "user", content: { text: "hi" } },
      { role: "assistant", content: { text: "hello" } },
      { role: "assistant", content: "plain string" },
    ];
    expect(appendMissingToolResults(messages, SKIPPED_BY)).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it("uses ONE phrasing with the codex-side belt (codex-message-convert MISSING_TOOL_OUTPUT)", () => {
    expect(MISSING_TOOL_RESULT_TEXT).toBe(MISSING_TOOL_OUTPUT);
  });
});

// ── Blast radius: readers of the committed rows ─────────────────────────────

function opRow(m: CommitTurnMessage, seq: number): OpMessageRow {
  return {
    messageId: m.messageId ?? `msg-${seq}`,
    opId: "op-1",
    turnIdx: 3,
    seqInTurn: seq,
    role: m.role,
    content: m.content,
    createdAt: "2026-08-31T00:00:00.000Z",
  };
}
function asCanonical(m: CommitTurnMessage, seq: number): CanonicalMessage {
  const r = opRow(m, seq);
  return { messageId: r.messageId, role: r.role, content: r.content, turnIdx: r.turnIdx, seqInTurn: r.seqInTurn };
}
// Mirrors anthropic-transport.ts toOpenAiMessage (module-private) for the
// roles a tool turn replays: assistant+toolCalls → tool_calls, tool → tool_call_id.
function toChatParam(m: TransportMessage): ChatCompletionMessageParam {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments },
      })),
    } as ChatCompletionMessageParam;
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId ?? "tc-unknown", content: m.content } as ChatCompletionMessageParam;
  }
  return { role: m.role, content: m.content } as ChatCompletionMessageParam;
}
type Block = { type: string; id?: string; tool_use_id?: string };
function pairing(params: ChatCompletionMessageParam[]): { uses: string[]; results: string[] } {
  const out = convertMessages(params);
  const blocks = out.flatMap(m => (Array.isArray(m.content) ? (m.content as Block[]) : []));
  return {
    uses: blocks.filter(b => b.type === "tool_use").map(b => b.id as string),
    results: blocks.filter(b => b.type === "tool_result").map(b => b.tool_use_id as string),
  };
}

describe("synthesized rows through the next turn's replay", () => {
  beforeEach(() => vi.clearAllMocks());

  // The committed transcript after a skipped dispatch — exactly what
  // buildTurnInput reads back from op_messages on turn+1.
  function committed(): CommitTurnMessage[] {
    const messages = [{ role: "user", content: { text: "book it" } } as CommitTurnMessage, assistantRow(TWO_CALLS)];
    appendMissingToolResults(messages, SKIPPED_BY);
    return messages;
  }

  it("(c) canonical-to-transport → Anthropic convertMessages: every tool_use has its tool_result, no orphan", () => {
    const transport = canonicalToTransport(committed().map(asCanonical), undefined);
    expect(transport.map(m => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(transport.slice(2)).toEqual([
      { role: "tool", toolCallId: "call-a", content: MISSING_TOOL_RESULT_TEXT },
      { role: "tool", toolCallId: "call-b", content: MISSING_TOOL_RESULT_TEXT },
    ]);
    expect(pairing(transport.map(toChatParam))).toEqual({
      uses: ["call-a", "call-b"],
      results: ["call-a", "call-b"],
    });
  });

  it("CONTROL: without the producer fix the same turn replays two orphan tool_use blocks", () => {
    const orphan = [{ role: "user", content: { text: "book it" } } as CommitTurnMessage, assistantRow(TWO_CALLS)];
    const transport = canonicalToTransport(orphan.map(asCanonical), undefined);
    expect(pairing(transport.map(toChatParam))).toEqual({ uses: ["call-a", "call-b"], results: [] });
  });

  it("codex Responses input: each function_call gets exactly one function_call_output, the belt adds none", () => {
    const params = committed().map((m, i) => opMessageRowToChatParam(opRow(m, i))).filter((p): p is ChatCompletionMessageParam => p !== null);
    const items = convertMessagesToInput(params) as Array<{ type: string; call_id?: string; output?: string }>;
    expect(items.filter(i => i.type === "function_call").map(i => i.call_id)).toEqual(["call-a", "call-b"]);
    expect(items.filter(i => i.type === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "call-a", output: MISSING_TOOL_RESULT_TEXT },
      { type: "function_call_output", call_id: "call-b", output: MISSING_TOOL_RESULT_TEXT },
    ]);
  });

  it("(d) message-convert persists a synthesized row to session.messages in the same shape as a real tool row", () => {
    const real = opMessageRowToChatParam(opRow(realRow("tc1"), 0));
    const synth = opMessageRowToChatParam(opRow({ role: "tool_result", content: synthesized("tc2") }, 1));
    expect(real).not.toBeNull();
    expect(synth).toEqual({ role: "tool", tool_call_id: "tc2", content: MISSING_TOOL_RESULT_TEXT });
    expect(Object.keys(synth as object)).toEqual(Object.keys(real as object));
  });

  it("step-effort never classifies the step after a synthesized row as mechanical (status is error)", () => {
    const read = [{ id: "r1", name: "read" }];
    const skipped = [assistantRow(read)];
    appendMissingToolResults(skipped, SKIPPED_BY);
    expect(classifyStepEffort({ turnIdx: 1, messages: skipped.map(asCanonical), pendingRedirect: undefined }))
      .toBe("standard");
    // Control: the same read with a REAL ok result is the mechanical case.
    const answered = [assistantRow(read), realRow("r1")];
    expect(classifyStepEffort({ turnIdx: 1, messages: answered.map(asCanonical), pendingRedirect: undefined }))
      .toBe("mechanical");
  });
});
