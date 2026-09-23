/**
 * A LEARNED WORKFLOW nudge tells the model to call `protocol(action:"get")`.
 * The weak and medium essential sets do not carry `protocol`, so without this
 * seam the nudge named a tool the local model did not have — and the
 * imported skill it pointed at was never read (27B skills baseline,
 * 2026-09-23: 0 protocol calls in 12 runs).
 *
 * EXP-16: with the profile's `nudgeInToolDescription`, the tool's own
 * description carries the instruction on the nudge turn, because the 8B
 * reasons from its tool list and walked past the prompt notice 3/3.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

const data = mkdtempSync(join(tmpdir(), "lax-nudge-tools-"));
process.env.LAX_DATA_DIR = data;

const { _resetSessionToolsForTests, selectTools } = await import("./tool-selection.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const { ESSENTIAL_TOOLS_ORDER } = await import("../../tools/tier-tool-set.js");
const { resolveModelProfile, profileFileName, USER_PROFILE_SUBDIR, _resetModelProfilesForTests } = await import("../../local-runtimes/model-profile.js");

const PROTOCOL_DESC = "Work with protocols — pre-built multi-step workflows the agent knows.";

function tool(name: string): ToolDefinition {
  return {
    name, description: name === "protocol" ? PROTOCOL_DESC : `${name} does a thing.`,
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }),
  };
}

function catalog(): ToolDefinition[] {
  const all = [...new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search", "protocol", "email_send"])].map(tool);
  applyAudiences(all);
  return all;
}

/** A profile for `id` cloned from the bundled 8B one, with the flag as asked. */
function declareProfile(id: string, nudgeInToolDescription: boolean) {
  const { profileId: _i, profileHash: _h, source: _s, ...whole } = resolveModelProfile("qwen3:8b")!;
  const dir = join(data, USER_PROFILE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, profileFileName(id)), JSON.stringify({ ...whole, id, nudgeInToolDescription }));
  _resetModelProfilesForTests();
}

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name);
const SUGGESTION = { name: "vercel-deploy" };

async function turn(model: string, protocolSuggestion: { name: string } | null, message = "deploy the acme-site project to vercel as a preview") {
  return (await selectTools({
    message, sessionId: `nudge-${model}-${protocolSuggestion ? "on" : "off"}`, channel: "web", allAgentTools: catalog(), bridgeTools: [],
    resolvedProvider: "local", resolvedModel: model, protocolSuggestion,
  })).tools;
}

beforeEach(() => { _resetSessionToolsForTests(); _setToolRAGForTests({ isReady: true, select: async () => [] }); });
afterEach(() => _setToolRAGForTests(null));

describe("the protocol nudge puts the protocol tool in the schema", () => {
  it("a weak local model gets `protocol` only when the prompt will name it", async () => {
    expect(names(await turn("qwen3:8b", null))).not.toContain("protocol");
    const nudged = names(await turn("qwen3:8b", SUGGESTION));
    expect(nudged).toContain("protocol");
    expect(nudged).toContain("tool_search");
  });

  it("a medium local model likewise", async () => {
    expect(names(await turn("qwen3.6:27b", null))).not.toContain("protocol");
    expect(names(await turn("qwen3.6:27b", SUGGESTION))).toContain("protocol");
  });

  it("a bridge turn is left alone", async () => {
    const bridgeOnly = [tool("bridge_reply")];
    const result = await selectTools({
      message: "deploy to vercel", sessionId: "nudge-bridge", channel: "telegram", allAgentTools: catalog(), bridgeTools: bridgeOnly,
      resolvedProvider: "local", resolvedModel: "qwen3:8b", protocolSuggestion: SUGGESTION,
    });
    expect(names(result.tools)).toEqual(["bridge_reply"]);
  });
});

describe("EXP-16: the nudge rides in the protocol tool's description when the profile says so", () => {
  const protocolOf = (ts: ToolDefinition[]) => ts.find((t) => t.name === "protocol")!;

  it("flag on: the description opens with the get instruction for the named protocol, and only on the nudge turn", async () => {
    declareProfile("nudgedesc:8b", true);
    const nudged = protocolOf(await turn("nudgedesc:8b", SUGGESTION));
    expect(nudged.description.startsWith('FIRST, for this request: a stored protocol "vercel-deploy" matches it — call protocol(action:"get", params:{name:"vercel-deploy"})')).toBe(true);
    expect(nudged.description).toContain(PROTOCOL_DESC);
    // The other tools' bytes are untouched.
    const others = (await turn("nudgedesc:8b", SUGGESTION)).filter((t) => t.name !== "protocol");
    for (const t of others) expect(t.description).toBe(catalog().find((c) => c.name === t.name)!.description);
    // Next turn, no nudge: the tool stays (mission routing remembers names) but the description is the plain one.
    const plain = (await selectTools({
      message: "now list the deployments", sessionId: "nudge-nudgedesc:8b-on", channel: "web", allAgentTools: catalog(), bridgeTools: [],
      resolvedProvider: "local", resolvedModel: "nudgedesc:8b", protocolSuggestion: null,
    })).tools;
    expect(names(plain)).toContain("protocol");
    expect(protocolOf(plain).description).toBe(PROTOCOL_DESC);
  });

  it("flag off: the tool is included but its description is untouched", async () => {
    declareProfile("plaindesc:8b", false);
    expect(protocolOf(await turn("plaindesc:8b", SUGGESTION)).description).toBe(PROTOCOL_DESC);
  });

  it("an unprofiled model keeps the prompt-only nudge", async () => {
    expect(protocolOf(await turn("granite3.3:8b", SUGGESTION)).description).toBe(PROTOCOL_DESC);
  });
});
