import { describe, it, expect } from "vitest";
import { collectRuntimeToolNames } from "./runtime-tool-names.js";
import { knownNonToolIdentifiers, scanToolNameCollections, type ToolNameCollection } from "./tool-name-collections.js";

// Hand-kept lists of tool names rot: a renamed or removed tool leaves a dead
// entry that silently stops doing its job (a deny that denies nothing, an
// essential that never loads, a category that never matches). Every fact about
// a tool is a field on its policy row (src/tool-policy/tool-policies.types.ts),
// and every set of tools a role, kit, template, job or surface gets is chosen
// by what the tools are for (the row's `tags`, src/tools/tool-kits.ts
// selectTools). What is left is registered below, so this test can check each
// name against the catalog the runtime actually registers: the deliberate
// exceptions a selection names beside its tags, and the literals of formats
// that are not ours. Any collection naming two or more tools that is
// registered nowhere fails: derive it from the rows, register it here, or
// declare it not a tool list with why.

interface Registered {
  file: string;
  /** The declaration that owns the collection: `CONST_NAME`, `.property` (every
   *  such property in the file), or `fn()`. */
  owner: string;
  /** Each literal is a comma-joined set of names (a turn's tool shape,
   *  `http_request,http_request`), every one of which must be a tool. */
  literal?: "name-set";
}

const REGISTRY: readonly Registered[] = [
  // Deliberate exceptions beside a tag selection, each with its reason in the
  // record. One-name exceptions are checked by selectTools itself.
  { file: "src/agency/agent-roles.ts", owner: ".plus" },
  { file: "src/rbac.ts", owner: ".plus" },
  { file: "src/agent-request/prepare-request/tool-selection.ts", owner: "ALSO_BUILDS" },
  { file: "src/tools/tool-kits.ts", owner: "CODE_SESSION_KIT" },
  // Outside formats and test data: names as another system spells them.
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
  { file: "src/tools/document-tools.ts", owner: ".actions", why: "the family's actions (create/read/edit/template)" },
  { file: "src/tool-policy/tool-policies.apps.ts", owner: ".forActions", why: "the family actions a path spec applies to" },
  { file: "src/tool-policy/tool-policies.types.ts", owner: "OP_CATEGORIES", why: "what an op was mostly doing (browser, computer, coding are categories)" },
  { file: "src/app-runtime/validation.ts", owner: "levels", why: "an app's access levels (read/write/admin)" },
  { file: "src/tools/app-tools/lifecycle.ts", owner: "execute()", why: "an app's access levels (read/write/admin)" },
  { file: "src/sandbox/win-cage-grants.ts", owner: "granted", why: "filesystem grant kinds (read/write)" },
  { file: "src/sandbox/win-cage-grants.ts", owner: "grantsNeeded()", why: "filesystem grant kinds (read/write)" },
  { file: "src/routes/security.ts", owner: "handleSecurityRoutes", why: "the tool-policy toggle's switch names (bash/http/browser); http is not a tool" },
  { file: "src/routes/security.ts", owner: "ruleMap", why: "the tool-policy toggle's switch names, keyed to policy rule ids" },
  { file: "src/protocols/skill-md-parser.ts", owner: "CATEGORY_MAP", why: "words in a skill's name, mapped to its display category" },
  { file: "src/canonical-loop/adapters/tool-call-text-corpus.ts", owner: ".tools", why: "a corpus case's offered tool set, with a near-miss name (read_file) on purpose" },
  { file: "scripts/local-qualification/lifecycle-helpers.ts", owner: "LIFECYCLE_BARRIERS", why: "the qualification lifecycle's barrier steps (write is a step)" },
];

const key = (c: { file: string; owner: string }) => `${c.file} ${c.owner}`;
const entryFor = (c: ToolNameCollection, table: readonly Registered[]) => table.find((r) => r.file === c.file && r.owner === c.owner);

describe("every hand-kept list of tool names is registered, and every registered name is a tool", () => {
  let registered: Set<string>;
  let found: ToolNameCollection[];

  it("scans the source tree", async () => {
    registered = await collectRuntimeToolNames();
    found = scanToolNameCollections(process.cwd(), (n) => registered.has(n));
    expect(found.length).toBeGreaterThan(20);
  });

  it("a collection the scan finds is registered, a source of truth, or declared not a tool list", () => {
    const tables = [...REGISTRY, ...SOURCES_OF_TRUTH, ...NOT_TOOL_LISTS];
    const unregistered = found.filter((c) => !entryFor(c, tables)).map((c) => `${c.file}:${c.line} ${c.owner} (${c.kind}: ${c.names.slice(0, 6).join(", ")}${c.names.length > 6 ? ", …" : ""})`);
    expect(
      unregistered,
      "a new hand-kept list of tool names: select it by tag (src/tools/tool-kits.ts selectTools) or derive it from another row fact (src/tool-registry.ts accessors); a deliberate exception or an outside format goes in REGISTRY above so dead names are caught, a collection that is not about tools in NOT_TOOL_LISTS with why",
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
        entry.literal === "name-set" ? name.split(",").every((n) => registered.has(n))
        : registered.has(name) || nonTools.has(name);
      for (const name of c.names) if (!isLive(name)) dead.push(`${name} in ${c.owner} (${c.file}:${c.line})`);
    }
    expect(dead, "a list names a tool that is not registered — the entry is dead; rename or remove it").toEqual([]);
  });
});
