import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { BLOCKED_CALLS_KEPT, blockedCallsIn } from "./run-blocks.js";

function call(id: string, name: string): ChatCompletionMessageParam {
  return { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] };
}
function result(id: string, reason?: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content: reason ? "[blocked]" : "[ok]", ...(reason ? { _block: { layer: "security", reason } } : {}) } as ChatCompletionMessageParam;
}

describe("blockedCallsIn", () => {
  it("lists each refused call by the tool that made it, and skips the ones that ran", () => {
    const messages = [call("a", "bash"), result("a", 'Blocked: "mount" reaches the system'), call("b", "read"), result("b"), call("c", "http_request"), result("c", "host not allowed")];
    expect(blockedCallsIn(messages)).toEqual([
      { tool: "bash", reason: 'Blocked: "mount" reaches the system' },
      { tool: "http_request", reason: "host not allowed" },
    ]);
  });

  it("is empty for a run that had nothing refused", () => {
    expect(blockedCallsIn([call("a", "bash"), result("a")])).toEqual([]);
  });

  it("keeps the first few; the transcript holds the rest", () => {
    const many = Array.from({ length: BLOCKED_CALLS_KEPT + 5 }, (_, i) => [call(`c${i}`, "bash"), result(`c${i}`, `r${i}`)]).flat();
    expect(blockedCallsIn(many)).toHaveLength(BLOCKED_CALLS_KEPT);
  });
});
