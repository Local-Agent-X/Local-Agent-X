// A message that says "answer with tool X" is only an honest request when the
// turn it lands in has X. The build engine asked its lead for `build_decide`
// in turns whose tool set did not hold it (label-check-grok, 2026-11-26).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-owed-tools-"));

const { oweSessionTool, owedToolNamesFor } = await import("./session-owed-tools.js");
const { selectTools } = await import("./tool-selection.js");
const { _resetSessionToolsForTests } = await import("./session-tool-memory.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const kits = await import("../../tools/tool-kits.js");

describe("oweSessionTool", () => {
  it("holds the tool for the session until it is released, and for no other session", () => {
    const release = oweSessionTool("chat-a", "build_decide");
    expect(owedToolNamesFor("chat-a")).toEqual(["build_decide"]);
    expect(owedToolNamesFor("chat-b")).toEqual([]);
    release();
    expect(owedToolNamesFor("chat-a")).toEqual([]);
  });

  it("is counted: two requests for one tool keep it until both are done, and a second release does nothing", () => {
    const first = oweSessionTool("chat-a", "build_decide");
    const second = oweSessionTool("chat-a", "build_decide");
    first();
    first();
    expect(owedToolNamesFor("chat-a")).toEqual(["build_decide"]);
    second();
    expect(owedToolNamesFor("chat-a")).toEqual([]);
  });
});

describe("a turn's tool set holds what the session is owed", () => {
  const tool = (name: string): ToolDefinition =>
    ({ name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) });
  const KIT = kits.selectTools(kits.CODE_SESSION_KIT);
  const catalog = () => {
    const all = [...new Set([...KIT, "build_decide", "email_send", "browser"])].map(tool);
    applyAudiences(all);
    return all;
  };
  const turn = async (sessionId: string, mode: "code" | "chat", model: string, provider: string) =>
    (await selectTools({
      message: "what is the status", sessionId, channel: "web", mode, allAgentTools: catalog(), bridgeTools: [],
      resolvedProvider: provider, resolvedModel: model,
    })).tools.map((t) => t.name);

  beforeEach(() => {
    _resetSessionToolsForTests();
    _setToolRAGForTests({ isReady: true, select: async () => [] } as never);
  });

  // A code session's kit does not carry build_decide, and what the model
  // loaded through tool_search is forgotten on a restart: that is the turn the
  // lead was in. Owed, the tool is there; not owed, the kit is as it was.
  it.each([
    ["a weaker model", "grok-4.7", "xai"],
    ["a strong model", "claude-opus-5-5", "anthropic"],
  ] as const)("a code session on %s: the owed tool is there while it is owed, and only then", async (_label, model, provider) => {
    expect(KIT).not.toContain("build_decide");
    const session = `owed-code-${model}`;
    const release = oweSessionTool(session, "build_decide");
    expect(await turn(session, "code", model, provider)).toContain("build_decide");
    expect(await turn(`other-code-${model}`, "code", model, provider)).not.toContain("build_decide");
    release();
    _resetSessionToolsForTests();
    expect(await turn(session, "code", model, provider)).not.toContain("build_decide");
  });

  // A chat picks tools per message, so whether it has one depends on the
  // message. Owed, it has it whatever the message was about.
  it.each([
    ["a weaker model", "grok-4.7", "xai"],
    ["a strong model", "claude-opus-5-5", "anthropic"],
  ] as const)("a chat on %s: the owed tool is there whatever the message picked", async (_label, model, provider) => {
    const session = `owed-chat-${model}`;
    const release = oweSessionTool(session, "build_decide");
    expect(await turn(session, "chat", model, provider)).toContain("build_decide");
    release();
  });
});
