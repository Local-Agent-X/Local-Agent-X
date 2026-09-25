/**
 * EXP-18: with `toolMembership: "essentials"` the index pins the tier set the
 * shrink produced and adds only the message's picks; with "catalog" (today)
 * it pins every main-chat tool and the whole catalog goes out. Either way a
 * destructive tool never ships without its undo counterpart.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../types.js";

const data = mkdtempSync(join(tmpdir(), "lax-membership-"));
process.env.LAX_DATA_DIR = data;

const { _resetSessionToolsForTests, selectTools } = await import("./tool-selection.js");
const { _setToolRAGForTests } = await import("../../tools/tool-rag.js");
const { applyAudiences } = await import("../../tools/audience-map.js");
const { ESSENTIAL_TOOLS_ORDER } = await import("../../tools/tier-tool-set.js");
const { resolveModelProfile, profileFileName, USER_PROFILE_SUBDIR, _resetModelProfilesForTests } = await import("../../local-runtimes/model-profile.js");
const { unpairedDestructive } = await import("../../tools/undo-pairs.js");

function tool(name: string): ToolDefinition {
  return { name, description: `${name} does a thing.`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) };
}

/** A realistic catalog: the essentials, discovery, forty main-chat extras, then
 *  the delete/restore pair. Order matters: the medium tier's two intent slots
 *  are filled by catalog order when nothing is prioritized, so the pair sits
 *  after the extras and can only enter as a pick or as a pair. */
function catalog(): ToolDefinition[] {
  const extras = Array.from({ length: 40 }, (_, i) => `extra_tool_${i}`);
  const all = [...new Set<string>([...ESSENTIAL_TOOLS_ORDER, "tool_search", ...extras, "email_send", "delete_file", "restore_file"])].map(tool);
  applyAudiences(all);
  // The synthetic extras are main-chat tools like everything the audience map does not know.
  for (const t of all) if (t.name.startsWith("extra_tool_")) t.audiences = ["main-chat"];
  return all;
}

function declareProfile(id: string, toolMembership: "catalog" | "essentials", tier: "A" | "B" | "C" = "B") {
  const { profileId: _i, profileHash: _h, source: _s, ...whole } = resolveModelProfile("qwen3.6:27b")!;
  const dir = join(data, USER_PROFILE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, profileFileName(id)), JSON.stringify({ ...whole, id, toolMembership, tier }));
  _resetModelProfilesForTests();
}

/** An index whose only semantic pick is delete_file when the message says delete, email_send when it says email. */
const index = () => ({
  isReady: true,
  select: async (message: string, all: ToolDefinition[], opts?: { corePinned?: string[] }) => {
    const pinned = new Set(opts?.corePinned ?? []);
    const picks = new Set<string>();
    if (/delete/.test(message)) picks.add("delete_file");
    if (/email/.test(message)) picks.add("email_send");
    return all.filter((t) => pinned.has(t.name) || picks.has(t.name));
  },
});

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name);

async function turn(model: string, message: string) {
  return names((await selectTools({
    message, sessionId: `membership-${model}-${message}`, channel: "web", allAgentTools: catalog(), bridgeTools: [],
    resolvedProvider: "local", resolvedModel: model,
  })).tools);
}

beforeEach(() => { _resetSessionToolsForTests(); _setToolRAGForTests(index()); });
afterEach(() => _setToolRAGForTests(null));

describe("EXP-18 tool membership", () => {
  it("catalog membership ships every main-chat tool (today's behaviour)", async () => {
    declareProfile("catalog:27b", "catalog");
    const set = await turn("catalog:27b", "delete the old build folder");
    expect(set.length).toBeGreaterThan(60);
    expect(set).toContain("extra_tool_39");
  });

  it("essentials membership ships the tier set plus the message's picks, and nothing else", async () => {
    declareProfile("essentials:27b", "essentials");
    const set = await turn("essentials:27b", "delete the old build folder");
    expect(set.length).toBeLessThan(40);
    expect(set).toContain("read");
    expect(set).toContain("tool_search");
    expect(set).toContain("delete_file");
    expect(set).not.toContain("extra_tool_39");
    expect(set).not.toContain("email_send");
  });

  it("a destructive pick brings its undo counterpart — the EXP-7 failure cannot recur", async () => {
    declareProfile("essentials:27b", "essentials");
    const set = await turn("essentials:27b", "delete the old build folder");
    expect(set).toContain("restore_file");
    expect(unpairedDestructive(set.map(tool))).toEqual([]);
    const plain = await turn("essentials:27b", "summarize the readme");
    expect(plain).not.toContain("delete_file");
    expect(plain).not.toContain("restore_file");
  });

  it("the pairing also holds under catalog membership", async () => {
    declareProfile("catalog:27b", "catalog");
    expect(unpairedDestructive((await turn("catalog:27b", "delete the old build folder")).map(tool))).toEqual([]);
  });

  it("an unprofiled strong model is untouched — the whole catalog, as before", async () => {
    const set = await turn("claude-opus-5-5", "delete the old build folder");
    expect(set.length).toBeGreaterThan(60);
  });

  // EXP-24: a strong model whose profile opts into essentials is shrunk to the
  // MEDIUM tier's essential set as its base (the strong tier never had a shrink
  // of its own), then gets the message's picks and the undo pairing like the
  // local tiers. Only a profile can opt a strong model in.
  it("a strong model whose profile says essentials gets the medium essential set plus the picks", async () => {
    declareProfile("strong-essentials-test", "essentials", "A");
    const set = await turn("strong-essentials-test", "delete the old build folder");
    expect(set.length).toBeLessThan(40);
    expect(set).toContain("read");
    expect(set).toContain("tool_search");
    expect(set).toContain("delete_file");
    expect(set).toContain("restore_file");
    expect(set).not.toContain("extra_tool_39");
    expect(unpairedDestructive(set.map(tool))).toEqual([]);
    // A strong profile that says catalog is the unprofiled behaviour.
    declareProfile("strong-catalog-test", "catalog", "A");
    expect((await turn("strong-catalog-test", "delete the old build folder")).length).toBeGreaterThan(60);
  });
});
