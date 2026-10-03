import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPluginContext } from "./plugin.js";
import { allTools } from "./registry-build.js";
import { plugins } from "./plugins.js";
import { unifiedRegistry } from "./registry.js";
import { AUDIENCES_BY_TOOL } from "./audience-map.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { SESSION_SCOPED_TOOLS } from "../tool-execution/resolve-tool.js";
import { builderToolsForTier } from "./build-app-runtime.js";
import { createArikernelBridgeTools } from "./arikernel-bridge.js";

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
  "src/context/agents-md-section.ts",
  "src/context/runtime-section.ts",
];

async function registeredToolNames(): Promise<Set<string>> {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-tool-coverage-"));
  const ctx = {
    secretsStore: {},
    memoryIndex: {},
    cronService: {},
    dataDir,
    activeOnEventBySession: new Map(),
    activeBrowserSessionIdRef: { value: "" },
    activeRuntimeBySession: new Map(),
    registry: unifiedRegistry,
  } as unknown as ToolPluginContext;
  const names = new Set(allTools.map((t) => t.name));
  try {
    for (const plugin of plugins) {
      for (const tool of await plugin.register(ctx)) names.add(tool.name);
    }
    for (const tool of builderToolsForTier("full-stack")) names.add(tool.name);
    for (const tool of createArikernelBridgeTools({ sqliteDatabase: {} as never })) names.add(tool.name);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return names;
}

/** Backticked snake_case identifiers in the prompt sources: the shape a tool
 *  reference takes there ("Call `search_past_sessions` when…"). Single-word
 *  tokens are ambiguous with file and env names and are not checked. */
function promptToolReferences(): Map<string, string> {
  const refs = new Map<string, string>();
  for (const file of PROMPT_SOURCES) {
    const text = readFileSync(join(process.cwd(), file), "utf-8");
    for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) refs.set(m[1], file);
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

  it("the system prompt sources", () => {
    const refs = promptToolReferences();
    expect(refs.size).toBeGreaterThan(0);
    expect(missing(refs.keys()).map((n) => `${n} (${refs.get(n)})`)).toEqual([]);
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
