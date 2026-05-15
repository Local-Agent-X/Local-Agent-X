/**
 * Layer 4 — prose-degeneracy nudge.
 *
 * Detects "model has been responding in prose for N turns" and, when the
 * user pivots to action, injects a corrective system block forcing a
 * tool_use this turn. Breaks the conversational-pattern-mimicry that
 * Layer 3 sanitization can't reach (Layer 3 is about leak shapes; this
 * is about the model imitating its own prior prose-only behavior).
 *
 * Live failure 2026-05-13: 7 turns of planning conversation conditioned
 * claude opus into pure prose. When user said "go to the website" and
 * "exit plan mode", model emitted `<response>...</response>` text wrapper
 * with no tool call — even though 65 tools were available.
 */

import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ThreatEngine } from "../src/threat-engine.js";
import { augmentSystemPrompt } from "../src/routes/chat/system-prompt-augmentations.js";

// Stub threat engine — only `getCanaryBlock` is touched in the augmenter's
// first line. Everything else this test cares about is the Layer 4 path.
const stubThreatEngine = { getCanaryBlock: () => "" } as unknown as ThreatEngine;

function mkAssistant(text: string, toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>): ChatCompletionMessageParam {
  if (toolCalls && toolCalls.length > 0) {
    return { role: "assistant", content: text, tool_calls: toolCalls } as ChatCompletionMessageParam;
  }
  return { role: "assistant", content: text } as ChatCompletionMessageParam;
}

function mkUser(text: string): ChatCompletionMessageParam {
  return { role: "user", content: text };
}

describe("Layer 4 — prose-degeneracy nudge", () => {
  it("injects TOOL-CALL REQUIRED when 3+ prose-only assistant turns + action verb", async () => {
    const prepared = {
      systemPrompt: "Base prompt.",
      messages: [
        mkUser("hi"),
        mkAssistant("hello"),
        mkUser("tell me about Y"),
        mkAssistant("Y is a thing"),
        mkUser("more details?"),
        mkAssistant("more details about Y"),
      ],
    };
    await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", "navigate to example.com");
    expect(prepared.systemPrompt).toContain("[TOOL-CALL REQUIRED THIS TURN]");
    expect(prepared.systemPrompt).toMatch(/Your last 3 assistant turns/);
    expect(prepared.systemPrompt).toContain("navigate");
  });

  it("does NOT inject when fewer than 3 prose-only turns", async () => {
    const prepared = {
      systemPrompt: "Base prompt.",
      messages: [
        mkUser("hi"),
        mkAssistant("hi"),
        mkUser("ping"),
        mkAssistant("pong"),
      ],
    };
    await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", "navigate to example.com");
    expect(prepared.systemPrompt).not.toContain("[TOOL-CALL REQUIRED");
  });

  it("does NOT inject when last assistant turn had a tool_call", async () => {
    const tc = [{ id: "1", type: "function" as const, function: { name: "browser", arguments: "{}" } }];
    const prepared = {
      systemPrompt: "Base prompt.",
      messages: [
        mkUser("a"), mkAssistant("a"),
        mkUser("b"), mkAssistant("b"),
        mkUser("c"), mkAssistant("c"),
        mkUser("d"), mkAssistant("", tc),  // streak broken by recent tool_call
      ],
    };
    await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", "click the button");
    expect(prepared.systemPrompt).not.toContain("[TOOL-CALL REQUIRED");
  });

  it("does NOT inject when user message has no action verb", async () => {
    const prepared = {
      systemPrompt: "Base prompt.",
      messages: [
        mkUser("a"), mkAssistant("a"),
        mkUser("b"), mkAssistant("b"),
        mkUser("c"), mkAssistant("c"),
      ],
    };
    await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", "tell me your thoughts on architecture");
    expect(prepared.systemPrompt).not.toContain("[TOOL-CALL REQUIRED");
  });

  it("matches a variety of action verbs", async () => {
    const baseMessages: ChatCompletionMessageParam[] = [
      mkUser("a"), mkAssistant("a"),
      mkUser("b"), mkAssistant("b"),
      mkUser("c"), mkAssistant("c"),
    ];
    for (const verb of ["click", "open", "submit", "navigate", "search", "run", "save", "delete"]) {
      const prepared = { systemPrompt: "p", messages: [...baseMessages] };
      await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", `please ${verb} the thing`);
      expect(prepared.systemPrompt, `expected nudge for verb '${verb}'`).toContain("[TOOL-CALL REQUIRED");
    }
  });

  it("instructs the model to call exit_plan_mode if blocked", async () => {
    const prepared = {
      systemPrompt: "p",
      messages: [
        mkUser("a"), mkAssistant("a"),
        mkUser("b"), mkAssistant("b"),
        mkUser("c"), mkAssistant("c"),
      ],
    };
    await augmentSystemPrompt(prepared, stubThreatEngine, "sess-test", "open the page");
    expect(prepared.systemPrompt).toContain("exit_plan_mode");
  });
});
