/**
 * Per-tool availability predicate (ToolDefinition.available).
 *
 * The failure mode this guards is SILENTLY HIDING A TOOL THAT WORKS: no error,
 * no log, the agent simply can't do something and the user reads it as the
 * model being stupid. That is strictly worse than advertising a tool that fails
 * with a clear message, so every default here must be non-narrowing — absent
 * predicate, throwing predicate, non-boolean return all mean AVAILABLE — and
 * tool_search / ALWAYS_ON_TOOLS can never be hidden at all.
 *
 * The manifest is the other half: filtering only the resolved set would make
 * every hidden tool reappear BY NAME in the deferred-tool manifest, moving the
 * lie rather than removing it.
 */
import { describe, it, expect } from "vitest";
import { resolveToolsForRequest, filterAvailableTools, isToolAvailable } from "../src/tools/tool-search.js";
import { buildDeferredToolManifest } from "../src/tools/tool-prompt-builder.js";
import type { ToolDefinition, Audience } from "../src/types.js";

function tool(
  name: string,
  opts: { audiences?: Audience[]; available?: () => boolean } = {},
): ToolDefinition {
  return {
    name,
    description: `${name} does a thing.`,
    parameters: {},
    execute: async () => ({ content: "" }),
    ...(opts.audiences ? { audiences: opts.audiences } : {}),
    ...(opts.available ? { available: opts.available } : {}),
  };
}

const names = (tools: ToolDefinition[]) => new Set(tools.map((t) => t.name));
const EVERY_AUDIENCE: Audience[] = ["main-chat", "spawned-agent", "operator", "build-intent"];

describe("availability predicate — non-narrowing defaults", () => {
  it("resolves a tool with NO predicate for every audience, exactly as before", () => {
    const all = [tool("plain", { audiences: EVERY_AUDIENCE })];
    for (const audience of ["main-chat", "spawned-agent", "operator"] as Audience[]) {
      expect(names(resolveToolsForRequest({ audience, message: "hi" }, all)).has("plain")).toBe(true);
    }
    // build-intent is reached through main-chat's strip-down branch.
    const stripped = resolveToolsForRequest(
      { audience: "main-chat", message: "build me a site", buildIntentTest: () => true },
      all,
    );
    expect(names(stripped).has("plain")).toBe(true);
  });

  it("treats a THROWING predicate as available and does not poison other tools", () => {
    const all = [
      tool("boom", {
        audiences: ["main-chat", "spawned-agent"],
        available: () => { throw new Error("predicate exploded"); },
      }),
      tool("bystander", { audiences: ["main-chat", "spawned-agent"] }),
      tool("hidden", { audiences: ["main-chat", "spawned-agent"], available: () => false }),
    ];
    for (const audience of ["main-chat", "spawned-agent"] as Audience[]) {
      const got = names(resolveToolsForRequest({ audience, message: "hi" }, all));
      expect(got.has("boom")).toBe(true);       // fail OPEN
      expect(got.has("bystander")).toBe(true);  // one bad predicate breaks nothing else
      expect(got.has("hidden")).toBe(false);
    }
  });

  it("treats a non-boolean return as available (only an explicit false hides)", () => {
    const weird = tool("weird", { available: (() => undefined) as unknown as () => boolean });
    expect(isToolAvailable(weird)).toBe(true);
  });
});

describe("availability predicate — what it actually hides", () => {
  it("drops an unavailable tool from the resolved set for main-chat and non-chat audiences", () => {
    const all = [
      tool("gone", { audiences: ["main-chat", "spawned-agent", "operator"], available: () => false }),
      tool("kept", { audiences: ["main-chat", "spawned-agent", "operator"] }),
    ];
    for (const audience of ["main-chat", "spawned-agent", "operator"] as Audience[]) {
      const got = names(resolveToolsForRequest({ audience, message: "hi" }, all));
      expect(got.has("gone")).toBe(false);
      expect(got.has("kept")).toBe(true);
    }
  });

  it("hides an unavailable tool even when a literal call or keyword names it", () => {
    const all = [tool("gone", { available: () => false })];
    const got = names(
      resolveToolsForRequest(
        {
          audience: "main-chat",
          message: "gone()",
          literalCallDetector: () => new Set(["gone"]),
          keywordRouter: () => new Set(["gone"]),
        },
        all,
      ),
    );
    expect(got.has("gone")).toBe(false);
  });

  it("honours availability on the spawned-agent templateAllowedTools branch", () => {
    // Different branch through resolveToolsForRequest — resolves from the full
    // set rather than the audience-tagged subset, so it needs its own pin.
    const all = [
      tool("gone", { available: () => false }),
      tool("kept"),
    ];
    const got = names(
      resolveToolsForRequest(
        { audience: "spawned-agent", templateAllowedTools: ["gone", "kept"] },
        all,
      ),
    );
    expect(got.has("gone")).toBe(false);
    expect(got.has("kept")).toBe(true);
  });
});

describe("availability predicate — tools that may never be hidden", () => {
  const HIDE = () => false;

  it("never hides tool_search, the escape hatch to every deferred tool", () => {
    const all = [tool("tool_search", { audiences: ["main-chat"], available: HIDE })];
    expect(isToolAvailable(all[0])).toBe(true);
    expect(names(resolveToolsForRequest({ audience: "main-chat", message: "hi" }, all)).has("tool_search")).toBe(true);
  });

  it("never hides an ALWAYS_ON_TOOLS member", () => {
    const alwaysOn = [
      "issue_create", "issue_list", "issue_update", "issue_search",
      "issue_checkout", "issue_release", "issue_request_approval",
      "agent_whoami", "agent_team_list", "agent_wakeup",
      "project_brief_read", "project_brief_update",
      "task_create", "task_update", "task_list", "task_get",
    ];
    const all = alwaysOn.map((n) => tool(n, { available: HIDE }));
    const got = names(
      resolveToolsForRequest(
        { audience: "spawned-agent", templateAllowedTools: ["nothing"] },
        all,
      ),
    );
    for (const n of alwaysOn) expect(got.has(n)).toBe(true);
  });
});

describe("availability predicate — the deferred manifest half", () => {
  const catalog = () => [
    tool("loaded_one", { audiences: ["main-chat"] }),
    tool("deferred_one"),
    tool("gone", { available: () => false }),
    tool("gone_deferred", { available: () => false }),
  ];

  // Exercises the PRODUCTION wiring in build-system-prompt.ts, not a
  // hand-composed filter — that is where the manifest inputs are chosen.
  async function manifestFor(all: ToolDefinition[], loaded: ToolDefinition[]): Promise<string> {
    const { buildSystemPrompt } = await import("../src/agent-request/prepare-request/build-system-prompt.js");
    return buildSystemPrompt({
      message: "hi there", // must not trip the cold-start verbs
      sessionId: `avail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      config: { systemPrompt: "Base prompt." } as never,
      memoryIndex: {} as never,
      integrations: { getAgentContext: () => "" } as never,
      allAgentTools: all,
      loadedTools: loaded,
      resolvedProvider: "anthropic",
      resolvedModel: "claude-opus-4-8",
      contextBlock: "", relevantMemories: "", smartContext: "", memoryContext: "",
      memoryNotifications: [], memoryCurateBlock: "", forceBuildIntent: false,
    });
  }

  it("keeps an unavailable tool out of the manifest, not just out of the schema", async () => {
    const all = catalog();
    const loaded = resolveToolsForRequest({ audience: "main-chat", message: "hi there" }, all);
    const prompt = await manifestFor(all, loaded);
    expect(prompt).toContain("- deferred_one:");
    expect(prompt).not.toContain("gone_deferred");
    expect(prompt).not.toContain("- gone:");
  });

  it("loaded ∪ manifested contains no unavailable tool and still names every available one", async () => {
    const all = catalog();
    const loaded = resolveToolsForRequest({ audience: "main-chat", message: "hi there" }, all);
    const prompt = await manifestFor(all, loaded);
    const union = new Set([
      ...loaded.map((t) => t.name),
      ...all.filter((t) => prompt.includes(`- ${t.name}:`)).map((t) => t.name),
    ]);
    expect(union).toEqual(new Set(filterAvailableTools(all).map((t) => t.name)));
  });

  it("the raw complement (pre-gate) would have leaked the hidden tools — pins why the gate is needed", () => {
    const all = catalog();
    const loaded = resolveToolsForRequest({ audience: "main-chat", message: "hi there" }, all);
    expect(buildDeferredToolManifest(all, loaded)).toContain("gone_deferred");
    expect(buildDeferredToolManifest(filterAvailableTools(all), loaded)).not.toContain("gone_deferred");
  });
});

describe("availability predicate — no accidental narrowing of the real catalog", () => {
  it("declares a predicate on exactly the email tools that need one", async () => {
    // The whole risk of this chunk is a tool going quiet. Pin the blast radius:
    // if a future change adds `available` anywhere else, this fails loudly.
    //
    // It fired as designed when C6 registered email_read_message and
    // email_folders: both are pure-IMAP tools that C4/C5 correctly gave the
    // predicate, but until they reached the barrel they were not in `allTools`,
    // so the set was silent about them. That is exactly the event this pin
    // exists to force a human to look at — a newly GATED tool appearing in the
    // model's catalog — and the answer here is "yes, deliberately, both are
    // unusable without IMAP". The pin is updated, not loosened: it is still an
    // exact-set equality, so the next gated tool trips it too.
    const { allTools } = await import("../src/tools/registry-build.js");
    const declared = allTools.filter((t) => t.available).map((t) => t.name).sort();
    expect(declared).toEqual([
      "email_folders", "email_read", "email_read_message", "email_search", "email_send",
    ]);
  });

  it("would still fire for a gated tool that slipped into the catalog unnoticed", async () => {
    // Proves the pin above is a live tripwire and not a list that happens to
    // match. MUTATION: this is what an unreviewed `available:` on a new tool
    // looks like — the assertion must reject it.
    const { allTools } = await import("../src/tools/registry-build.js");
    const smuggled = [
      ...allTools,
      { name: "sneaky_gated", description: "", parameters: { type: "object", properties: {}, required: [] },
        available: () => false, execute: async () => ({ content: "" }) },
    ];
    const declared = smuggled.filter((t) => t.available).map((t) => t.name).sort();
    expect(declared).not.toEqual([
      "email_folders", "email_read", "email_read_message", "email_search", "email_send",
    ]);
    expect(declared).toContain("sneaky_gated");
  });

  it("changes nothing for any real tool whose predicate says available", async () => {
    const { allTools } = await import("../src/tools/registry-build.js");
    // Same catalog with every predicate stripped = the pre-chunk behaviour.
    const asBefore = allTools.map((t) => ({ ...t, available: undefined }));
    const forced = allTools.map((t) => ({ ...t, available: () => true }));
    for (const audience of ["main-chat", "spawned-agent", "operator"] as Audience[]) {
      const before = resolveToolsForRequest({ audience, message: "hello there" }, asBefore).map((t) => t.name);
      const after = resolveToolsForRequest({ audience, message: "hello there" }, forced).map((t) => t.name);
      expect(after).toEqual(before);
    }
  });
});
