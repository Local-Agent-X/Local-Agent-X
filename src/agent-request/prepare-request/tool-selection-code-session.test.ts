/**
 * A code session (session/mode.ts) loads the code session kit, not the
 * per-message keyword filter and index picks: the same set on every message,
 * so the prompt prefix stays cached, plus whatever the model loaded through
 * tool_search earlier in the session. Everything else stays loadable through
 * tool_search.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-code-session-tools-"));

const { selectTools } = await import("./tool-selection.js");
const { _resetSessionToolsForTests, rememberSessionTools } = await import("./session-tool-memory.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const kits = await import("../../tools/tool-kits.js");

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

const KIT = kits.selectTools(kits.CODE_SESSION_KIT);
function catalog(): ToolDefinition[] {
  const all = [...new Set([...KIT, "email_send", "browser", "memory_search", "memory_save", "self_edit", "http_request", "pptx_create"])].map(tool);
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
    for (const name of ["bash", "read", "write", "edit", "grep", "glob", "structural_search", "update_plan", "wrap_up", "session_start", "exit_plan_mode", "task_create", "task_update", "task_list", "task_get"]) expect(KIT).toContain(name);
  });

  it("keeps the rest of the toolbox one tool_search away, not in every call's schema", () => {
    for (const name of ["process_start", "http_request", "web_fetch", "web_search", "view_image", "browser"]) {
      expect(KIT, name).not.toContain(name);
    }
    // Lean, but with the code-working tools a coding turn checks its work with:
    // structural_search (who uses a name) and review_changes (its own diff),
    // and session_start: a coding session is where a separate task turns up
    // (a bug in code you are not changing) and is worth its own session. Plus
    // exit_plan_mode (the Plan picker's approval card) and the task_* tools
    // (the step list one task at a time, as the Claude Code CLI keeps it), and
    // delete_file: the prompt's throwaway-script loop ends with it, and loading
    // it by tool_search cost every such run a step (parity battery 2026-11-17).
    // delete_file now comes from the coding kit's file-delete tag, which carries
    // its undo restore_file too: it joined the loaded set as delete_file's undo
    // counterpart before, so a session ships the same tools; the kit counts it.
    expect(KIT).toContain("delete_file");
    expect(KIT.length).toBeLessThanOrEqual(19);
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

  // Terminal-Bench smoke, 2026-10-24: qwen3.6's code session got browser,
  // self_edit, memory_save and memory_search in place of grep, glob and the
  // task tools, from the tier's essentials list.
  it("a local model's code session gets the same kit, only compacted", async () => {
    const local = await turn("fix the failing test", "local-code", "code", "qwen3.6:27b-172k");
    expect(names(local)).toEqual([...KIT].sort());
  });

  it("a chat keeps the per-message selection", async () => {
    expect(names(await turn("send an email about the release", "chat-1", "chat"))).toContain("email_send");
  });
});

// A phone app's session gets the device tools whatever chose its set
// (device-tools.ts): the android tool sat in no session's set, so a phone
// app's build agent never touched a device (2026-11-23).
describe("selectTools — a session working on a phone app", () => {
  const withDevices = () => [...catalog(), tool("android"), tool("device_check")];
  async function turnIn(dir: string, sessionId: string, mode: "code" | "chat") {
    const { setSessionWorkRoot } = await import("../../workspace/paths.js");
    setSessionWorkRoot(sessionId, dir);
    return names((await selectTools({
      message: "fix the scan screen", sessionId, channel: "web", mode, allAgentTools: withDevices(), bridgeTools: [],
      resolvedProvider: "anthropic", resolvedModel: "claude-opus-5-5",
    })).tools);
  }
  const project = (deps: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "lax-mobile-session-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    return dir;
  };

  it("a code session in an Expo app has android and device_check", async () => {
    const picked = await turnIn(project({ expo: "~52.0.0" }), "code-expo", "code");
    expect(picked).toEqual(expect.arrayContaining(["android", "device_check"]));
  });

  it("a chat bound to an Expo app has them too", async () => {
    const picked = await turnIn(project({ expo: "~52.0.0" }), "chat-expo", "chat");
    expect(picked).toEqual(expect.arrayContaining(["android", "device_check"]));
  });

  it("a code session in a web app does not", async () => {
    const picked = await turnIn(project({ react: "^19", vite: "^6" }), "code-web", "code");
    expect(picked).not.toContain("android");
    expect(picked).not.toContain("device_check");
  });
});
