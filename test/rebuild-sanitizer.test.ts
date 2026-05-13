/**
 * Layer 3 history-rebuild sanitizer — verify each known leak shape is
 * detected, stripped, and replaced with a corrective marker. Without
 * this layer, claude sees its own bad output in prior assistant turns
 * and mimics the pattern, degrading conversation quality over time.
 */

import { describe, it, expect } from "vitest";
import { sanitizeAssistantTextForRebuild } from "../src/anthropic-client/parse.js";

const TOOLS = new Set(["agent_spawn", "bash", "Bash", "primal_run_build_plan", "browser", "read"]);

describe("sanitizeAssistantTextForRebuild", () => {
  it("returns original text when no leak detected", () => {
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild("Hi Peter, here's the answer.", TOOLS);
    expect(cleaned).toBe("Hi Peter, here's the answer.");
    expect(leaks).toHaveLength(0);
  });

  it("strips OpenAI envelope (raw) + adds corrective marker", () => {
    const text = 'Done. {"tool_calls": [{"name": "bash", "arguments": {"command": "ls"}}]}';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("openai-envelope-raw");
    expect(leaks[0].toolName).toBe("bash");
    expect(cleaned).toContain("wire-format-error");
    expect(cleaned).not.toContain('"tool_calls"');
  });

  it("strips OpenAI envelope (fenced)", () => {
    const text = '```json\n{"tool_calls": [{"name": "read", "arguments": {"path": "x"}}]}\n```';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("openai-envelope-fenced");
    expect(cleaned).not.toContain("tool_calls");
  });

  it("strips Anthropic native shape", () => {
    const text = 'I will call:\n{"name":"agent_spawn","input":{"agent":"researcher","task":"q"}}';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("anthropic-native");
    expect(leaks[0].toolName).toBe("agent_spawn");
    expect(cleaned).toContain("wire-format-error");
    expect(cleaned).toContain("agent_spawn");
    expect(cleaned).not.toContain('"input"');
  });

  it("strips array-wrapped Anthropic shape + cleans up empty brackets", () => {
    const text = 'Building V4 now.\n[{"name": "bash", "input": {"command": "ls"}}]';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("anthropic-native-array");
    expect(cleaned).not.toMatch(/\[\s*\]/);
    expect(cleaned).toContain("wire-format-error");
  });

  it("strips XML <tool_use> form", () => {
    const text = '<tool_use><tool_name>bash</tool_name><parameter name="command">ls</parameter></tool_use>';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("anthropic-xml-tool-use");
    expect(cleaned).not.toContain("<tool_use>");
  });

  it("strips tree-style `Bash(...)` notation on its own line", () => {
    const text = 'Checking assets.\nBash(ls "C:/Users/manri/workspace")\nLet me try.';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("tree-style-call");
    expect(leaks[0].toolName).toBe("Bash");
    expect(cleaned).toContain("wire-format-error");
    expect(cleaned).toContain("Checking assets.");
    expect(cleaned).toContain("Let me try.");
  });

  it("strips tree-style with `└` lead character", () => {
    const text = "Now:\n└ Bash(ls -la /tmp)\nThen the result.";
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("tree-style-call");
  });

  it("does NOT strip prose mentions of tools by name", () => {
    const text = 'The bash tool can run commands. Try using it.';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it("strips placeholder narration `[Calling]` on its own line", () => {
    const text = "I'll check now.\n[Calling]\nResult will follow.";
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].shape).toBe("placeholder-narration");
    expect(cleaned).toContain("wire-format-error");
    expect(cleaned).not.toContain("[Calling]");
  });

  it("does NOT strip placeholders inside prose", () => {
    const text = "The [Calling] convention is a notation from CLI tools.";
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks).toHaveLength(0);
  });

  it("returns multiple leaks from a multi-shape message", () => {
    const text = `OK doing it.\n{"name":"agent_spawn","input":{"agent":"researcher","task":"q"}}\n[Calling]\nBash(ls)`;
    const { leaks } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(leaks.length).toBeGreaterThanOrEqual(2);
    const shapes = leaks.map(l => l.shape);
    expect(shapes).toContain("anthropic-native");
  });

  it("preserves surrounding prose between leaks", () => {
    const text = "Before.\n{\"name\":\"bash\",\"input\":{\"command\":\"ls\"}}\nAfter.";
    const { cleaned } = sanitizeAssistantTextForRebuild(text, TOOLS);
    expect(cleaned).toContain("Before.");
    expect(cleaned).toContain("After.");
    expect(cleaned).toContain("wire-format-error");
  });

  it("returns empty leaks + identical text when validToolNames missing", () => {
    const text = '{"name":"agent_spawn","input":{"agent":"r"}}';
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text);
    expect(leaks).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it("handles empty / null inputs without throwing", () => {
    expect(() => sanitizeAssistantTextForRebuild("", TOOLS)).not.toThrow();
    expect(sanitizeAssistantTextForRebuild("", TOOLS).leaks).toHaveLength(0);
  });
});
