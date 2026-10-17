import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTools } from "./registry-build.js";
import { unifiedRegistry } from "./registry.js";
import { AUDIENCES_BY_TOOL } from "./audience-map.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { SESSION_SCOPED_TOOLS } from "../tool-execution/resolve-tool.js";
import { collectRuntimeToolNames } from "./runtime-tool-names.js";
import { BROWSER_TOOL_PARAMETERS } from "./browser-tools/description.js";
import { FLIPPABLE_SETTINGS } from "../settings-schema.js";
import { createCoreProtocolTools } from "../protocols/index.js";
import { _seedBuiltinRoles } from "../agency/agent-roles.js";
import { builtInTemplateDefaults } from "../agent-store/template-defaults.js";
import { DREAM_TOOL_NAMES } from "../server/background-jobs/prompts.js";

// The startup coverage check and tool-policy-default.test.ts prove that every
// REGISTERED tool has a policy entry. Nothing proved the reverse, so a name
// could live in the policy table, the audience map, the resolver's list and
// the system prompt while no tool by that name was ever registered — and the
// model, told to call it, finds nothing and improvises (search_past_sessions,
// 2026-05-23 → 2026-09-30). This is the reverse direction: every name a
// referrer uses must be a tool the registry actually builds.
//
// The registered set is the same one boot assembles — the static catalog plus
// every plugin's register() — with a stub context, since the factories only
// capture the context in closures — plus the two paths that register after
// boot, read from their own factories: the app-build runtime's tools
// (builderToolsForTier) and the ARI bridge's SQLite tool, present only when a
// database is configured.

const PROMPT_SOURCES = [
  "src/context/system-prompt-builder.ts",
  "src/context/rule-registry.ts",
  "src/context/runtime-section.ts",
  // The two prompt files the product agent reads every turn. A tool name
  // written there that no longer exists leaves the agent calling a ghost
  // (2026-10-13: `browser_evaluate`, `browser_screenshot` in the secret rule).
  "config/agent-rules.md",
  "config/system-prompt.md",
];

const registeredToolNames = collectRuntimeToolNames;

/** Backticked snake_case names the prompt uses that are NOT tools and never
 *  will be: settings fields (`developer_mode`), browser and protocol actions
 *  (`new_tab`, `save_preference`), and two plain nouns. Derived from the real
 *  tables where one exists, so a renamed action can't go stale here. */
function knownNonToolIdentifiers(): Set<string> {
  const browserActions = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: readonly string[] }).enum;
  return new Set([
    ...FLIPPABLE_SETTINGS.map((s) => s.field),
    ...browserActions,
    // The `protocol` family's inner tools: not in the model-facing catalog
    // (the model calls `protocol` with an action), but core callers dispatch
    // them by name, so resolver tables may legitimately list them.
    ...createCoreProtocolTools().map((t) => t.name),
    "save_preference", // `protocol` tool action
    "node_modules",
    "run_id", // what agent_spawn returns
  ]);
}

/** Backticked snake_case identifiers in the prompt sources: the shape a tool
 *  reference takes there ("Call `search_past_sessions` when…"). Single-word
 *  tokens are ambiguous with file and env names and are not checked. */
function promptToolReferences(): Map<string, string> {
  const refs = new Map<string, string>();
  const nonTools = knownNonToolIdentifiers();
  for (const file of PROMPT_SOURCES) {
    const text = readFileSync(join(process.cwd(), file), "utf-8");
    for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      if (!nonTools.has(m[1])) refs.set(m[1], file);
    }
  }
  return refs;
}

/** Hand-maintained per-tool lists scattered through src/. None of them is
 *  derived from the registry, so a renamed or removed tool leaves a dead entry
 *  that silently stops doing its job (a deny that denies nothing, an essential
 *  that never loads). Half are module-private, and importing the route and
 *  loop modules that hold them would drag their side effects into this test,
 *  so the declarations are scanned in source: every `snake_case` string
 *  literal inside the declaration must be a registered tool. `keys` lists
 *  take only the top-level record keys (their values are actions or args). */
const TOOL_LISTS: Array<{ file: string; name: string; shape: "literals" | "keys" }> = [
  { file: "src/tool-execution/resolve-tool.ts", name: "OPERATION_SCOPED_TOOLS", shape: "literals" },
  { file: "src/tool-execution/resolve-tool.ts", name: "SESSION_REPEAT_SKIP_TOOLS", shape: "literals" },
  { file: "src/tools/tier-tool-set.ts", name: "ESSENTIAL_TOOLS_ORDER", shape: "literals" },
  { file: "src/tools/tool-search.ts", name: "ALWAYS_ON_TOOLS", shape: "literals" },
  { file: "src/tools/tool-companions.ts", name: "TOOL_COMPANIONS", shape: "literals" },
  { file: "src/server/voice-prompt.ts", name: "VOICE_FAST_TOOLS", shape: "literals" },
  // What strict local-only mode cannot read off a row: the reach the row
  // cannot name, in both directions.
  { file: "src/local-only-policy.ts", name: "INDIRECT_NETWORK", shape: "keys" },
  { file: "src/local-only-policy.ts", name: "LOCAL_DEVICE", shape: "keys" },
  { file: "src/committing-tool-check.ts", name: "ARG_AWARE_TOOLS", shape: "literals" },
  { file: "src/tool-execution/dedup-cache.ts", name: "DEDUP_SKIP", shape: "literals" },
  { file: "src/tool-execution/heap-guard.ts", name: "HEAP_GUARD_EXEMPT_TOOLS", shape: "literals" },
  { file: "src/ops/tools/delegated-toolset.ts", name: "DENIED_TOOL_NAMES", shape: "literals" },
  { file: "src/routes/mcp.ts", name: "MCP_HIDDEN_TOOLS", shape: "literals" },
  { file: "src/routes/chat/run-chat-turn/prepare-and-route.ts", name: "IDE_BLOCKED_TOOLS", shape: "literals" },
  { file: "src/canonical-loop/step-effort.ts", name: "MECHANICAL_TOOLS", shape: "literals" },
  { file: "src/tools/tool-kits.ts", name: "CODING_KIT", shape: "literals" },
  { file: "src/tools/tool-kits.ts", name: "BUILDER_KIT", shape: "literals" },
  { file: "src/agent-guards/loop-discovery.ts", name: "SPIRALABLE_TOOLS", shape: "literals" },
  // The user-facing capability blurbs; a blurb for a removed tool is dead weight.
  { file: "scripts/gen-agent-capabilities.ts", name: "BLURB", shape: "keys" },
];

/** The text of one `const NAME = …;` declaration: from its line to the first
 *  line that closes it at the left margin (or the line itself if one-lined). */
function declarationText(file: string, name: string): string {
  const lines = readFileSync(join(process.cwd(), file), "utf-8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(export )?const ${name}\\b`).test(l));
  if (start < 0) throw new Error(`${name} not found in ${file} — update TOOL_LISTS`);
  if (/;\s*$/.test(lines[start])) return lines[start];
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    out.push(lines[i]);
    if (/^\s{0,2}[\]}]\)?(\s*as const)?\)?;?\s*$/.test(lines[i])) break;
  }
  return out.join("\n");
}

function listToolReferences(): Map<string, string> {
  const refs = new Map<string, string>();
  const nonTools = knownNonToolIdentifiers();
  for (const { file, name, shape } of TOOL_LISTS) {
    const text = declarationText(file, name);
    // Top-level keys only (two-space indent): nested keys are actions or args.
    const re = shape === "keys"
      ? /^ {2}"?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"?\s*:/gm
      : /["'`]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["'`]/g;
    for (const m of text.matchAll(re)) if (!nonTools.has(m[1])) refs.set(m[1], `${name} (${file})`);
  }
  return refs;
}

describe("every tool name a referrer uses is a registered tool", () => {
  let registered: Set<string>;
  const missing = (names: Iterable<string>) => [...names].filter((n) => !registered.has(n));

  it("builds the registered set the way boot does", async () => {
    registered = await registeredToolNames();
    expect(registered.size).toBeGreaterThan(allTools.length);
  });

  it("audience map", () => {
    expect(missing(Object.keys(AUDIENCES_BY_TOOL))).toEqual([]);
  });

  it("policy tables (glob keys aside)", () => {
    expect(missing(Object.keys(TOOL_POLICIES).filter((k) => !k.includes("*")))).toEqual([]);
  });

  it("the resolver's session-scoped list", () => {
    expect(missing(SESSION_SCOPED_TOOLS)).toEqual([]);
  });

  // A role's tools become its agent's allowedTools (src/agents/catalog.ts): a
  // name that is not a tool is a tool the role silently lacks — researcher,
  // monitor and social-media named browser_navigate and could not browse.
  it("the built-in agent roles' and templates' tools, and the background jobs' belts", () => {
    const lists: Array<[string, readonly string[]]> = [
      ..._seedBuiltinRoles().map((r): [string, readonly string[]] => [`role ${r.name}`, r.suggestedTools]),
      ...builtInTemplateDefaults().map((t): [string, readonly string[]] => [`template ${t.id}`, t.allowedTools]),
      ["DREAM_TOOL_NAMES", DREAM_TOOL_NAMES],
    ];
    // A `*` entry names an MCP server's tools, registered only once it connects.
    const names = lists.flatMap(([where, tools]) => tools.filter((t) => !t.endsWith("*")).map((t) => `${t} (${where})`));
    expect(names.filter((n) => !registered.has(n.split(" ")[0]))).toEqual([]);
  });

  it("the system prompt sources", () => {
    const refs = promptToolReferences();
    expect(refs.size).toBeGreaterThan(0);
    expect(missing(refs.keys()).map((n) => `${n} (${refs.get(n)})`)).toEqual([]);
  });

  it("the hand-maintained per-tool lists", () => {
    const refs = listToolReferences();
    expect(refs.size).toBeGreaterThan(40);
    expect(
      missing(refs.keys()).map((n) => `${n} in ${refs.get(n)}`),
      "a list names a tool that is not registered — the entry is dead; rename or remove it",
    ).toEqual([]);
  });

  // bash is the one shell: ari_shell skipped bash's path confinement, cage,
  // output masking and taint, so no registration path may bring it back.
  it("never registers ari_shell, nor lists it in a referrer", () => {
    expect(registered.has("ari_shell")).toBe(false);
    expect(unifiedRegistry.get("ari_shell")).toBeUndefined();
    expect(Object.keys(TOOL_POLICIES)).not.toContain("ari_shell");
    expect(Object.keys(AUDIENCES_BY_TOOL)).not.toContain("ari_shell");
    expect(SESSION_SCOPED_TOOLS.has("ari_shell")).toBe(false);
  });
});
