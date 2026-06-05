/**
 * Tests for the tool-call-from-text fallback extractor.
 * Triggered by qwen3-next:80b + gpt-oss:20b leaking tool calls as
 * raw JSON in content (live failure 2026-05-12).
 */

import { describe, it, expect } from "vitest";
import {
  extractToolCallsFromText,
  proseLooksLikeToolCall,
} from "../src/canonical-loop/adapters/tool-call-text-extractor.js";

const TOOLS = new Set(["browser", "read", "write", "bash"]);

describe("extractToolCallsFromText — full envelope pattern", () => {
  it("extracts a bare OpenAI-shape envelope", () => {
    const text = '{"name": "browser", "arguments": {"action": "click", "ref": 49}}';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ action: "click", ref: 49 });
    expect(remainingText).toBe("");
  });

  it("ignores envelopes for unknown tools", () => {
    const text = '{"name": "unknown_tool", "arguments": {"x": 1}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("strips a ```json code fence wrapper", () => {
    const text = '```json\n{"name": "read", "arguments": {"path": "foo.txt"}}\n```';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
  });

  it("accepts arguments as a serialized JSON string", () => {
    const text = '{"name": "browser", "arguments": "{\\"action\\":\\"snapshot\\"}"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toBe('{"action":"snapshot"}');
  });
});

describe("extractToolCallsFromText — browser shorthand", () => {
  it("extracts {action, ref} as a browser tool call", () => {
    const text = '{"action":"click","ref":49}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ action: "click", ref: 49 });
  });

  it("extracts {action, coords} as browser", () => {
    const text = '{"action":"click","coords":[100,200]}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
  });

  it("extracts {action:'navigate', url} as browser", () => {
    const text = '{"action":"navigate","url":"https://x.com"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
  });

  it("does NOT extract {action} without recognizable browser key", () => {
    const text = '{"action":"something","unrelated":"field"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("does not synthesize browser when browser tool isn't allowed", () => {
    const text = '{"action":"click","ref":49}';
    const { toolCalls } = extractToolCallsFromText(text, new Set(["read"]));
    expect(toolCalls).toHaveLength(0);
  });
});

describe("extractToolCallsFromText — write/read prose narration", () => {
  // Live failure 2026-06-05 (Nutrishop demo, xAI Grok): the CEO agent narrated
  // FIVE write calls as prose in one turn, then "Committed" tripped the guard.
  const GROK_FIVE_WRITES = [
    'run tool write with path is /Users/dad/Projects/Local-Agent-X/workspace/subtask1-project-setup.txt content is Committed Subtask 1: Nutrishop McKinney Demo Project Setup. Status: Complete.',
    'run tool write with path is /Users/dad/Projects/Local-Agent-X/workspace/subtask2-hire-agents.txt content is Committed Subtask 2: Hire 4 agents. Status: Complete.',
    'run tool write with path is /Users/dad/Projects/Local-Agent-X/workspace/subtask3-product-catalog.txt content is Committed Subtask 3: Product Catalog Setup. Status: Complete.',
    'run tool write with path is /Users/dad/Projects/Local-Agent-X/workspace/subtask4-marketing-strategy.txt content is Committed Subtask 4: Marketing Strategy. Status: Complete.',
    'run tool write with path is /Users/dad/Projects/Local-Agent-X/workspace/subtask5-operations.txt content is Committed Subtask 5: Operations and Reporting. Status: Complete.',
  ].join("\n");

  it("reconstructs ALL five narrated write calls from one turn", () => {
    const { toolCalls } = extractToolCallsFromText(GROK_FIVE_WRITES, TOOLS);
    expect(toolCalls).toHaveLength(5);
    expect(toolCalls.every((t) => t.name === "write")).toBe(true);
    const first = JSON.parse(toolCalls[0].arguments);
    expect(first.path).toBe("/Users/dad/Projects/Local-Agent-X/workspace/subtask1-project-setup.txt");
    expect(first.content).toBe("Committed Subtask 1: Nutrishop McKinney Demo Project Setup. Status: Complete.");
    const last = JSON.parse(toolCalls[4].arguments);
    expect(last.path).toBe("/Users/dad/Projects/Local-Agent-X/workspace/subtask5-operations.txt");
    expect(last.content).toBe("Committed Subtask 5: Operations and Reporting. Status: Complete.");
  });

  it("reconstructs a single write (path + content)", () => {
    const text = "run tool write with path is /tmp/a.txt content is hello world";
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ path: "/tmp/a.txt", content: "hello world" });
  });

  it("captures multi-line content verbatim to end-of-call", () => {
    const text = "run tool write with path is /tmp/note.md content is line one\nline two\nline three";
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].arguments).content).toBe("line one\nline two\nline three");
  });

  it("reconstructs a read call (path only)", () => {
    const text = "use tool read with path is /etc/hosts";
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ path: "/etc/hosts" });
  });

  it("does not fire on a write mention with no value markers", () => {
    const { toolCalls } = extractToolCallsFromText("I'll write the results to a file shortly.", TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("reconstructs mixed write + bash in one turn", () => {
    const text = "run tool write with path is /tmp/x.txt content is hi\nrun tool bash with command is ls /tmp";
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((t) => t.name)).toEqual(["write", "bash"]);
    expect(JSON.parse(toolCalls[1].arguments).command).toBe("ls /tmp");
  });
});

describe("extractToolCallsFromText — shell prose narration", () => {
  // Live failure 2026-06-04 (Nutrishop demo, xAI Grok): instead of a
  // structured tool_call OR a JSON leak, Grok narrated the bash call in
  // plain English. The JSON extractor can't see it; the call never fires
  // and the trailing "File committed." trips the false-completion guard.
  const GROK_PROSE = [
    "run tool bash with command is cat > /Users/dad/Projects/Local-Agent-X/workspace/nutrishop_execution_start.md << 'EOL'",
    "Project execution started by CEO.",
    "Agents: 4 hired.",
    "Subtasks ready for assignment.",
    "EOL",
    'ls /Users/dad/Projects/Local-Agent-X/workspace/ && echo "File committed."',
  ].join("\n");

  it("reconstructs a bash call from the exact Grok narration (with heredoc)", () => {
    const { toolCalls } = extractToolCallsFromText(GROK_PROSE, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("bash");
    const cmd = JSON.parse(toolCalls[0].arguments).command as string;
    expect(cmd).toContain("cat > /Users/dad/Projects/Local-Agent-X/workspace/nutrishop_execution_start.md");
    expect(cmd).toContain("EOL"); // heredoc body captured, not truncated at newline
    expect(cmd).toContain('echo "File committed."');
  });

  it("reconstructs a single-line bash narration", () => {
    const { toolCalls } = extractToolCallsFromText("run tool bash with command is ls -la /tmp", TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("bash");
    expect(JSON.parse(toolCalls[0].arguments).command).toBe("ls -la /tmp");
  });

  it("does not fire when no shell tool is allowed", () => {
    const { toolCalls } = extractToolCallsFromText("run tool bash with command is ls", new Set(["read", "browser"]));
    expect(toolCalls).toHaveLength(0);
  });

  it("does not fire on a casual mention without a value marker", () => {
    // No "is/:/=" after "command" — this is explanatory prose, not an invocation.
    const { toolCalls } = extractToolCallsFromText("I'll run the bash command to verify the workspace.", TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("structured JSON still wins over prose when both could match", () => {
    const text = 'run tool bash\n{"name":"read","arguments":{"path":"a.txt"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
  });
});

describe("proseLooksLikeToolCall", () => {
  it("detects a 'run tool <name>' narration", () => {
    expect(proseLooksLikeToolCall("run tool bash with command is ls", TOOLS)).toBe(true);
  });
  it("detects 'call the read tool' narration", () => {
    expect(proseLooksLikeToolCall("Next I'll call the read tool on the file.", TOOLS)).toBe(true);
  });
  it("is false for a normal completion with no invocation language", () => {
    expect(proseLooksLikeToolCall("Done — the workspace looks healthy and all agents are hired.", TOOLS)).toBe(false);
  });
  it("is false for empty input", () => {
    expect(proseLooksLikeToolCall("", TOOLS)).toBe(false);
  });
});

describe("extractToolCallsFromText — edges + safety", () => {
  it("returns empty for plain prose with no JSON", () => {
    const r = extractToolCallsFromText("Hi Alex, how can I help?", TOOLS);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.remainingText).toBe("Hi Alex, how can I help?");
  });

  it("returns empty for empty/null input", () => {
    expect(extractToolCallsFromText("", TOOLS).toolCalls).toHaveLength(0);
    // @ts-expect-error testing runtime guard
    expect(extractToolCallsFromText(null, TOOLS).toolCalls).toHaveLength(0);
  });

  it("preserves prose before/after an extracted JSON", () => {
    const text = 'I\'ll click that now.\n{"action":"click","ref":7}\nThen check the page.';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(remainingText).toContain("I'll click that now.");
    expect(remainingText).toContain("Then check the page.");
    expect(remainingText).not.toContain('"action"');
  });

  it("extracts multiple tool calls from one assistant message", () => {
    const text = '{"name":"read","arguments":{"path":"a.txt"}}\n{"name":"read","arguments":{"path":"b.txt"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.every(t => t.name === "read")).toBe(true);
  });

  it("ignores malformed JSON without throwing", () => {
    const text = '{"name": "browser", "arguments": {action: "click"}}';
    expect(() => extractToolCallsFromText(text, TOOLS)).not.toThrow();
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("respects JSON string literals containing braces", () => {
    const text = '{"name":"write","arguments":{"path":"f.json","content":"{not a tool}"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("write");
    expect(JSON.parse(toolCalls[0].arguments).content).toBe("{not a tool}");
  });

  it("generates unique ids for each synthesized call", () => {
    const text = '{"name":"read","arguments":{"path":"a"}}\n{"name":"read","arguments":{"path":"b"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
    expect(toolCalls[0].id).toMatch(/^call_synth_/);
  });
});
