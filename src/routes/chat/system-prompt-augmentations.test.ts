/**
 * Layer 4 (the [TOOL-CALL REQUIRED THIS TURN] nudge) must classify what the
 * user AUTHORED, not a slash-command template.
 *
 * The chat orchestrator expands `/name args` BEFORE installEventWiring runs, so
 * `currentUserMessage` on a slash turn is the marker plus the whole SKILL.md
 * body. Every bundled template carries action verbs of its own ("delete",
 * "write", "run"), so after a 3-turn planning streak a bare `/senior-engineer`
 * — whose correct behaviour is to ack and ask for input — was told a tool call
 * is REQUIRED. Same class as the middleware fix in 2a64b4ef.
 *
 * The other two augmentations (security canary, parallel context) never read
 * the message; they are pinned as unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

vi.mock("../../ops/session-bridge.js", () => ({
  listOpsForSession: vi.fn(() => []),
  getOpTask: vi.fn(() => undefined),
}));

import { augmentSystemPrompt } from "./system-prompt-augmentations.js";
import { expandSlashCommand } from "../../slash-commands.js";
import type { ThreatEngine } from "../../threat/threat-engine.js";

const threatEngine = { getCanaryBlock: () => "\n\n[CANARY]" } as unknown as ThreatEngine;

const BARE = expandSlashCommand("/senior-engineer")!.agentMessage;
const WITH_ACTION_ARG = expandSlashCommand("/vibe-code delete every temp file")!.agentMessage;

/** Three trailing prose-only assistant turns — the Layer 4 streak threshold. */
function proseStreak(): ChatCompletionMessageParam[] {
  return [
    { role: "user", content: "let's plan" },
    { role: "assistant", content: "Plan A." },
    { role: "user", content: "and?" },
    { role: "assistant", content: "Plan B." },
    { role: "user", content: "more" },
    { role: "assistant", content: "Plan C." },
  ];
}

async function run(message: string, messages: ChatCompletionMessageParam[] = proseStreak()) {
  const prepared = { systemPrompt: "", renderedPromptSections: [] as never[], messages };
  await augmentSystemPrompt(prepared, threatEngine, "sess-layer4-slash", message);
  return prepared;
}

const sectionIds = (p: { renderedPromptSections: Array<{ id: string }> }) => p.renderedPromptSections.map((s) => s.id);

describe("premise: the template itself reads as an action request", () => {
  it("the bare /senior-engineer expansion carries action verbs the user never typed", () => {
    expect(BARE).not.toBe("/senior-engineer");
    expect(BARE).toMatch(/\b(delete|write|run|read|edit|create)\b/i);
  });
});

describe("Layer 4 prose-degeneracy nudge on slash-command turns", () => {
  it("bare /senior-engineer after a prose streak → NO tool-call-required injection", async () => {
    const p = await run(BARE);
    expect(sectionIds(p)).not.toContain("tool-call-required");
    expect(p.systemPrompt).not.toContain("[TOOL-CALL REQUIRED THIS TURN]");
  });

  it("/vibe-code delete every temp file → injection still fires (the ask IS an action) and quotes the user's verb", async () => {
    const p = await run(WITH_ACTION_ARG);
    expect(sectionIds(p)).toContain("tool-call-required");
    expect(p.systemPrompt).toContain('action language ("delete")');
  });

  it("plain 'delete every temp file' is unchanged — still fires", async () => {
    const p = await run("delete every temp file");
    expect(sectionIds(p)).toContain("tool-call-required");
    expect(p.systemPrompt).toContain('action language ("delete")');
  });

  it("does not fire without a prose streak, even on an action ask", async () => {
    const withTool: ChatCompletionMessageParam[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "assistant", content: "Done." },
    ];
    const p = await run("delete every temp file", withTool);
    expect(sectionIds(p)).not.toContain("tool-call-required");
  });
});

describe("the augmentations that never read the message are unaffected", () => {
  it("the security canary is appended on both a slash turn and a plain turn", async () => {
    for (const msg of [BARE, "delete every temp file"]) {
      const p = await run(msg);
      expect(sectionIds(p)).toContain("security-canary");
      expect(p.systemPrompt).toContain("[CANARY]");
    }
  });
});
