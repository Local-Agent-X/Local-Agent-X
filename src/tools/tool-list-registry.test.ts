import { describe, it, expect } from "vitest";
import { collectRuntimeToolNames } from "./runtime-tool-names.js";
import { knownNonToolIdentifiers, scanToolNameCollections, type ToolNameCollection } from "./tool-name-collections.js";

// Hand-kept lists of tool names rot: a renamed or removed tool leaves a dead
// entry that silently stops doing its job (a deny that denies nothing, an
// essential that never loads, a category that never matches). Most such lists
// were replaced by facts on the policy rows (src/tool-policy/) and derived
// there. The ones left are editorial — which tools a persona gets, which the
// small-model tier keeps, which a guard treats as discovery — and every one of
// them is registered below, so this test can check each name against the
// catalog the runtime actually registers. A collection the scan finds that is
// registered nowhere fails: either register it here, or derive it from a row
// fact so there is nothing to register.

interface Registered {
  file: string;
  /** The declaration that owns the collection: `CONST_NAME`, `.property` (every
   *  such property in the file), or `fn()`. */
  owner: string;
  /** What each literal is when not a tool name: a prefix (`memory_`) that
   *  must match a registered tool, or a comma-joined set of names (a turn's
   *  tool shape, `http_request,http_request`). */
  literal?: "prefix" | "name-set";
}

/** Editorial tool lists: a human choice no row fact expresses. */
const REGISTRY: readonly Registered[] = [
  // Which tools a role, template, worker or background job gets.
  { file: "src/agency/agent-roles.ts", owner: ".suggestedTools" },
  { file: "src/agent-store/template-defaults.ts", owner: ".allowedTools" },
  { file: "src/rbac.ts", owner: ".allowedTools" },
  { file: "src/tools/tool-kits.ts", owner: "CODING_KIT" },
  { file: "src/tools/tool-kits.ts", owner: "BUILDER_KIT" },
  { file: "src/tools/tool-kits.ts", owner: "OFFICE_KIT" },
  { file: "src/server/background-jobs/prompts.ts", owner: "DREAM_TOOL_NAMES" },
  { file: "src/canonical-loop/publish-review-submit.ts", owner: "REVIEWER_TOOLS" },
  { file: "src/ops/tools/delegated-toolset.ts", owner: "BUILD_MUTATION_TOOLS" },
  { file: "src/ops/tools/delegated-toolset.ts", owner: "DENIED_TOOL_NAMES" },
  // Which tools a surface shows or hides.
  { file: "src/tools/tier-tool-set.ts", owner: "ESSENTIAL_TOOLS_ORDER" },
  { file: "src/tools/tool-search.ts", owner: "ALWAYS_ON_TOOLS" },
  { file: "src/tools/tool-companions.ts", owner: "TOOL_COMPANIONS" },
  { file: "src/server/voice-prompt.ts", owner: "VOICE_FAST_TOOLS" },
  { file: "src/routes/mcp.ts", owner: "MCP_HIDDEN_TOOLS" },
  { file: "src/routes/chat/run-chat-turn/prepare-and-route.ts", owner: "IDE_BLOCKED_TOOLS" },
  { file: "src/agent-request/tool-filter.ts", owner: ".toolPrefixes", literal: "prefix" },
  { file: "src/agent-request/prepare-request/product-build-routing.ts", owner: "BUILD_WORKFLOW_TOOLS" },
  { file: "src/agent-request/prepare-request/product-build-routing.ts", owner: ".allowedWorkflowTools" },
  { file: "src/agent-request/prepare-request/tool-selection.ts", owner: "INLINE_BUILD_TOOLS" },
  { file: "src/integrations/types.ts", owner: "TRANSPORT_TOOLS" },
  { file: "src/tools/result-helpers.ts", owner: "toolPrompts" },
  { file: "src/publish-operation.ts", owner: "NOT_PUBLISH_TOOLS" },
  { file: "src/server/background-jobs/skill-review-prompt.ts", owner: "SKILL_REVIEW_TOOL_NAMES" },
  // The user-facing capability blurbs; a blurb for a removed tool is dead weight.
  { file: "scripts/gen-agent-capabilities.ts", owner: "BLURB" },
  // How the loop reads a call: discovery, repeats, effort, silence, category.
  { file: "src/agent-guards/loop-discovery.ts", owner: "SPIRALABLE_TOOLS" },
  { file: "src/agent-guards/loop-discovery.ts", owner: "REPEAT_SEARCH_TOOLS" },
  { file: "src/agent-guards/loop-discovery.ts", owner: "hint" },
  { file: "src/canonical-loop/step-effort.ts", owner: "MECHANICAL_TOOLS" },
  { file: "src/canonical-loop/turn-loop/silent-tool-check.ts", owner: "MEMORY_WRITE_TOOLS" },
  { file: "src/canonical-loop/turn-loop/silent-tool-check.ts", owner: "SILENT_FIRE_AND_FORGET_TOOLS" },
  { file: "src/canonical-loop/middlewares/mid-turn-stale.ts", owner: "SPIN_PRONE_ACTION_TOOLS" },
  { file: "src/tool-tracker.ts", owner: "CATEGORY_TOOLS" },
  { file: "src/tool-execution/heap-guard.ts", owner: "HEAP_GUARD_EXEMPT_TOOLS" },
  { file: "src/committing-tool-check.ts", owner: "ARG_AWARE_TOOLS" },
  // What the resolver stamps into which call.
  { file: "src/tool-execution/egress-payload.ts", owner: "LOCAL_CONTROL_ARGS" },
  { file: "src/ari-kernel/evaluate.ts", owner: "SECRET_VAULT_ACTION_MAP" },
  { file: "src/tool-execution/kill-switch-gates.ts", owner: ".matches" },
  { file: "src/security/layer/layer-core.ts", owner: "evaluate()" },
  // What strict local-only mode cannot read off a row (both directions).
  { file: "src/local-only-policy.ts", owner: "INDIRECT_NETWORK" },
  { file: "src/local-only-policy.ts", owner: "LOCAL_DEVICE" },
  // Wire and corpus fixtures.
  { file: "src/anthropic-client/oauth-direct.ts", owner: "CLASSIFIER_FINGERPRINT_TOOLS" },
  { file: "src/canonical-loop/adapters/tool-call-text-corpus.ts", owner: "CORPUS_TOOL_NAMES" },
  { file: "src/agent-guards/livelock-shapes.test-helper.ts", owner: "LIVELOCK_SHAPES", literal: "name-set" },
  { file: "src/test-suite.ts", owner: "expected" },
];

/** The tables of tool names the rest of the registry is checked against:
 *  the policy rows and the audience map name every tool by construction
 *  (tool-reference-coverage.test.ts checks them the other way round). */
const SOURCES_OF_TRUTH: readonly Registered[] = [
  { file: "src/tool-policy/tool-policies.core.ts", owner: "TOOL_POLICIES_CORE" },
  { file: "src/tool-policy/tool-policies.network.ts", owner: "TOOL_POLICIES_NETWORK" },
  { file: "src/tool-policy/tool-policies.memory.ts", owner: "TOOL_POLICIES_MEMORY" },
  { file: "src/tool-policy/tool-policies.orchestration.ts", owner: "TOOL_POLICIES_ORCHESTRATION" },
  { file: "src/tool-policy/tool-policies.apps.ts", owner: "TOOL_POLICIES_APPS" },
  { file: "src/tools/audience-map.ts", owner: "AUDIENCES_BY_TOOL" },
];

/** Collections of words that are also tool names but are not about tools. */
const NOT_TOOL_LISTS: ReadonlyArray<Registered & { why: string }> = [
  { file: "src/tools/spreadsheet-tools.ts", owner: ".actions", why: "the family's actions (read/write/edit/query)" },
];

const key = (c: { file: string; owner: string }) => `${c.file} ${c.owner}`;
const entryFor = (c: ToolNameCollection, table: readonly Registered[]) => table.find((r) => r.file === c.file && r.owner === c.owner);

describe("every hand-kept list of tool names is registered, and every registered name is a tool", () => {
  let registered: Set<string>;
  let found: ToolNameCollection[];

  it("scans the source tree", async () => {
    registered = await collectRuntimeToolNames();
    found = scanToolNameCollections(process.cwd(), (n) => registered.has(n));
    expect(found.length).toBeGreaterThan(40);
  });

  it("a collection the scan finds is registered, a source of truth, or declared not a tool list", () => {
    const tables = [...REGISTRY, ...SOURCES_OF_TRUTH, ...NOT_TOOL_LISTS];
    const unregistered = found.filter((c) => !entryFor(c, tables)).map((c) => `${c.file}:${c.line} ${c.owner} (${c.kind}: ${c.names.slice(0, 6).join(", ")}${c.names.length > 6 ? ", …" : ""})`);
    expect(
      unregistered,
      "a new hand-kept list of tool names: derive it from the policy rows (src/tool-registry.ts accessors) or register it in REGISTRY above so dead names are caught",
    ).toEqual([]);
  });

  it("every registered entry still matches a collection", () => {
    const stale = [...REGISTRY, ...SOURCES_OF_TRUTH, ...NOT_TOOL_LISTS].filter((r) => !found.some((c) => c.file === r.file && c.owner === r.owner)).map(key);
    expect(stale, "the list was removed or renamed — drop or update its entry").toEqual([]);
  });

  it("every name in a registered list is a registered tool", () => {
    const nonTools = knownNonToolIdentifiers();
    const dead: string[] = [];
    for (const c of found) {
      const entry = entryFor(c, REGISTRY);
      if (!entry) continue;
      const isLive = (name: string): boolean =>
        entry.literal === "prefix" ? [...registered].some((t) => t.startsWith(name))
        : entry.literal === "name-set" ? name.split(",").every((n) => registered.has(n))
        : registered.has(name) || nonTools.has(name);
      for (const name of c.names) if (!isLive(name)) dead.push(`${name} in ${c.owner} (${c.file}:${c.line})`);
    }
    expect(dead, "a list names a tool that is not registered — the entry is dead; rename or remove it").toEqual([]);
  });
});
