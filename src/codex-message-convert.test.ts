import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { MISSING_TOOL_OUTPUT, convertMessagesToInput } from "./codex-message-convert.js";

// convertMessagesToInput is the single seam that shapes codex requests. Since
// llm-dispatch now routes vision (screenshot) dispatches through it, the
// image_url → Responses-API input_image mapping is load-bearing: if it ever
// regresses, the design judge silently grades blind on codex.
describe("convertMessagesToInput — user content", () => {
  it("maps an image_url part to the Responses-API input_image shape", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          { type: "text", text: "judge this" },
        ],
      },
    ] as unknown as ChatCompletionMessageParam[];

    const input = convertMessagesToInput(messages) as Array<{ type: string; role: string; content: unknown[] }>;
    expect(input).toHaveLength(1);
    expect(input[0].type).toBe("message");
    expect(input[0].role).toBe("user");
    expect(input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" },
      { type: "input_text", text: "judge this" },
    ]);
  });

  it("keeps a plain string user message as a single input_text part (no regression)", () => {
    const input = convertMessagesToInput([
      { role: "user", content: "hello" },
    ] as ChatCompletionMessageParam[]) as Array<{ content: unknown[] }>;
    expect(input[0].content).toEqual([{ type: "input_text", text: "hello" }]);
  });
});

type Item = Record<string, unknown>;

function toolCall(id: string, path: string) {
  return { id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } };
}

/** [type, call_id | role | id] per item, so a shape assertion reads like the transcript. */
function shape(input: Item[]): Array<[unknown, unknown]> {
  return input.map((i) => [i.type, i.call_id ?? i.role ?? i.id]);
}

function synthesized(input: Item[]): Item[] {
  return input.filter((i) => i.output === MISSING_TOOL_OUTPUT);
}

describe("convertMessagesToInput — tool calls", () => {
  // Pinned byte-for-byte: when every function_call has a matching tool result
  // the orphan repair must be a no-op, so the wire shape stays exactly what
  // the Responses API has been accepting.
  it("emits reasoning, calls, text, then outputs unchanged when every call is answered", () => {
    const messages = [
      {
        role: "assistant",
        content: "reading both",
        tool_calls: [toolCall("call_a|fc_a", "a"), toolCall("call_b|fc_b", "b")],
        _reasoning: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }],
      },
      { role: "tool", tool_call_id: "call_a|fc_a", content: "A contents" },
      { role: "tool", tool_call_id: "call_b|fc_b", content: "B contents" },
      { role: "user", content: "thanks" },
    ] as unknown as ChatCompletionMessageParam[];

    const expected = [
      { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
      { type: "function_call", name: "read_file", call_id: "call_a", id: "fc_a", arguments: '{"path":"a"}' },
      { type: "function_call", name: "read_file", call_id: "call_b", id: "fc_b", arguments: '{"path":"b"}' },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reading both" }] },
      { type: "function_call_output", call_id: "call_a", output: "A contents" },
      { type: "function_call_output", call_id: "call_b", output: "B contents" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ];
    expect(JSON.stringify(convertMessagesToInput(messages))).toBe(JSON.stringify(expected));
  });

  // The producer shape: the loop committed an assistant row with calls A and
  // B but a result only for A (skipToolDispatch, or a run cut mid-call). B's
  // placeholder lands where B's real output would have — after A's — so the
  // call group stays contiguous and the outputs follow it in call order.
  it("places the synthesized output after the call group, in call order", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [toolCall("call_a", "a"), toolCall("call_b", "b")] },
      { role: "tool", tool_call_id: "call_a", content: "A contents" },
      { role: "user", content: "continue" },
    ] as unknown as ChatCompletionMessageParam[];

    const input = convertMessagesToInput(messages) as Item[];
    expect(shape(input)).toEqual([
      ["function_call", "call_a"],
      ["function_call", "call_b"],
      ["function_call_output", "call_a"],
      ["function_call_output", "call_b"],
      ["message", "user"],
    ]);
    expect(input[2].output).toBe("A contents");
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_b", output: MISSING_TOOL_OUTPUT });
    expect(synthesized(input)).toHaveLength(1);
  });

  it("releases an earlier unanswered call's output before a later call's real one", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("call_a", "a"), toolCall("call_b", "b")],
        _reasoning: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }],
      },
      { role: "tool", tool_call_id: "call_b", content: "B contents" },
    ] as unknown as ChatCompletionMessageParam[];

    const input = convertMessagesToInput(messages) as Item[];
    expect(shape(input)).toEqual([
      ["reasoning", "rs_1"],
      ["function_call", "call_a"],
      ["function_call", "call_b"],
      ["function_call_output", "call_a"],
      ["function_call_output", "call_b"],
    ]);
    expect(input[3].output).toBe(MISSING_TOOL_OUTPUT);
    expect(input[4].output).toBe("B contents");
  });

  it("answers every call, after the row's text, when no tool result was appended at all", () => {
    const messages = [
      { role: "assistant", content: "working", tool_calls: [toolCall("call_a", "a"), toolCall("call_b", "b")] },
      { role: "user", content: "continue" },
    ] as unknown as ChatCompletionMessageParam[];

    const input = convertMessagesToInput(messages) as Item[];
    expect(shape(input)).toEqual([
      ["function_call", "call_a"],
      ["function_call", "call_b"],
      ["message", "assistant"],
      ["function_call_output", "call_a"],
      ["function_call_output", "call_b"],
      ["message", "user"],
    ]);
    expect(synthesized(input)).toHaveLength(2);
  });

  // IDs are compound ("call_id|item_id") on both sides; the orphan match must
  // go through decodeToolCallId, not raw string equality — a result stored
  // under the bare call_id still answers a compound call.
  it("matches compound call|item ids through decodeToolCallId on both sides", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("call_a|fc_a", "a"), toolCall("call_b|fc_b", "b"), toolCall("call_c|fc_c", "c")],
      },
      { role: "tool", tool_call_id: "call_a|fc_a", content: "A contents" },
      { role: "tool", tool_call_id: "call_c", content: "C contents" },
    ] as unknown as ChatCompletionMessageParam[];

    expect(convertMessagesToInput(messages)).toEqual([
      { type: "function_call", name: "read_file", call_id: "call_a", id: "fc_a", arguments: '{"path":"a"}' },
      { type: "function_call", name: "read_file", call_id: "call_b", id: "fc_b", arguments: '{"path":"b"}' },
      { type: "function_call", name: "read_file", call_id: "call_c", id: "fc_c", arguments: '{"path":"c"}' },
      { type: "function_call_output", call_id: "call_a", output: "A contents" },
      { type: "function_call_output", call_id: "call_b", output: MISSING_TOOL_OUTPUT },
      { type: "function_call_output", call_id: "call_c", output: "C contents" },
    ]);
  });
});
