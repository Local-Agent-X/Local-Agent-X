/**
 * A local model whose profile routes tools per MISSION gets the session's
 * union, the way strong models always have: the set only grows, so two
 * consecutive messages ship byte-identical tools unless a new one is needed.
 *
 * Why it matters on the local wire: the chat template renders the tool
 * schemas after the system text, so a set that changes 74→75→74 across
 * messages re-prefills the tools and the whole history at every arrival —
 * 30-37k tokens per user message, measured on qwen3.6:27b (EXP-12,
 * docs/harness/HARNESS_LOG.md). Per-message routing keeps today's behaviour.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { ToolDefinition } from "../../types.js";

const data = mkdtempSync(join(tmpdir(), "lax-sticky-tools-"));
process.env.LAX_DATA_DIR = data;

const { _resetSessionToolsForTests, selectTools } = await import("./tool-selection.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const { ESSENTIAL_TOOLS_ORDER } = await import("../../tools/tier-tool-set.js");
const { resolveModelProfile, profileFileName, USER_PROFILE_SUBDIR, _resetModelProfilesForTests } = await import("../../local-runtimes/model-profile.js");

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

function catalog(): ToolDefinition[] {
  const names = new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search", "email_send", "calendar_add", "restore_file"]);
  const all = [...names].map(tool);
  applyAudiences(all);
  return all;
}

/** A profile for `id` cloned from the bundled 27B one, routing tools as asked. */
function declareProfile(id: string, toolRouting: "message" | "mission") {
  const { profileId: _i, profileHash: _h, source: _s, ...whole } = resolveModelProfile("qwen3.6:27b")!;
  const dir = join(data, USER_PROFILE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, profileFileName(id)), JSON.stringify({ ...whole, id, toolRouting }));
  _resetModelProfilesForTests();
}

/** An index that picks one extra tool per message, so per-message routing
 *  produces a DIFFERENT set for each message. */
const indexPickingByMessage = () => ({
  isReady: true,
  select: async (message: string, all: ToolDefinition[]) =>
    all.filter((t) => message.includes("email") ? t.name === "email_send" : message.includes("calendar") ? t.name === "calendar_add" : false),
});

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name).sort();

async function turn(model: string, message: string) {
  return (await selectTools({
    message, sessionId: `sticky-${model}`, channel: "web", allAgentTools: catalog(), bridgeTools: [],
    resolvedProvider: "local", resolvedModel: model,
  })).tools;
}

beforeEach(() => { _resetSessionToolsForTests(); _setToolRAGForTests(indexPickingByMessage()); });
afterEach(() => _setToolRAGForTests(null));

describe("tool routing per mission", () => {
  it("per-message routing re-picks: the second message's set drops the first's extra tool", async () => {
    declareProfile("permsg:27b", "message");
    const first = await turn("permsg:27b", "send an email");
    const second = await turn("permsg:27b", "add a calendar entry");
    expect(names(first)).toContain("email_send");
    expect(names(second)).toContain("calendar_add");
    expect(names(second)).not.toContain("email_send");
  });

  it("per-mission routing keeps the union: the second set is a superset of the first, and a third identical message changes nothing", async () => {
    declareProfile("mission:27b", "mission");
    const first = await turn("mission:27b", "send an email");
    const second = await turn("mission:27b", "add a calendar entry");
    const third = await turn("mission:27b", "add a calendar entry");
    expect(names(second)).toEqual(expect.arrayContaining(names(first)));
    expect(names(second)).toContain("calendar_add");
    // Byte-identical, not just the same names: descriptions are compacted
    // after the union so the wire bytes are a function of the set alone.
    expect(JSON.stringify(third)).toBe(JSON.stringify(second));
  });

  it("an unprofiled local model keeps per-message routing", async () => {
    const first = await turn("granite3.3:8b", "send an email");
    const second = await turn("granite3.3:8b", "add a calendar entry");
    expect(names(second)).not.toContain("email_send");
  });
});
