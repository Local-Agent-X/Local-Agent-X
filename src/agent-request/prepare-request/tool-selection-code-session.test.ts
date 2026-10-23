/**
 * A code session (session/mode.ts) loads the code session kit, not the
 * per-message keyword filter and index picks: the same set on every message,
 * so the prompt prefix stays cached, plus whatever the model loaded through
 * tool_search earlier in the session. Everything else stays loadable through
 * tool_search.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-code-session-tools-"));

const { _resetSessionToolsForTests, rememberSessionTools, selectTools } = await import("./tool-selection.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const kits = await import("../../tools/tool-kits.js");

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

const KIT = kits.selectTools(kits.CODE_SESSION_KIT);
function catalog(): ToolDefinition[] {
  const all = [...new Set([...KIT, "email_send", "browser", "memory_search", "pptx_create"])].map(tool);
  applyAudiences(all);
  return all;
}

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name).sort();
async function turn(message: string, sessionId = "code-session", mode: "code" | "chat" = "code", model = "claude-opus-5-5") {
  return (await selectTools({
    message, sessionId, channel: "web", mode, allAgentTools: catalog(), bridgeTools: [],
    resolvedProvider: "anthropic", resolvedModel: model,
  })).tools;
}

beforeEach(() => {
  _resetSessionToolsForTests();
  // An index that would add the email tool on an email message — a code
  // session must not consult it.
  _setToolRAGForTests({ isReady: true, select: async (m: string, all: ToolDefinition[]) => all.filter((t) => m.includes("email") && t.name === "email_send") } as never);
});

describe("selectTools — a code session", () => {
  it("loads the code session kit, tool_search included", async () => {
    expect(names(await turn("fix the failing test"))).toEqual([...KIT].sort());
    expect(KIT).toContain("tool_search");
    for (const name of ["bash", "process_start", "read", "edit", "http_request", "task_create"]) expect(KIT).toContain(name);
  });

  it("ships the same set whatever the message says", async () => {
    const a = names(await turn("add a login page", "s1"));
    const b = names(await turn("send an email about the release", "s2"));
    expect(b).toEqual(a);
    expect(b).not.toContain("email_send");
  });

  it("keeps a tool the model loaded through tool_search for the rest of the session", async () => {
    await turn("set up the repo");
    rememberSessionTools("code-session", ["memory_search"]);
    expect(names(await turn("what package manager do I use?"))).toContain("memory_search");
  });

  it("a chat keeps the per-message selection", async () => {
    expect(names(await turn("send an email about the release", "chat-1", "chat"))).toContain("email_send");
  });
});
