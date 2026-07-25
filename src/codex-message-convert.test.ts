import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { convertMessagesToInput } from "./codex-message-convert.js";

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
