# Registries: declare once, derive or verify the rest

The single biggest source of "I changed X and Y silently broke" is the
**N-table registry**. You add a tool, route, event type, permission, or
provider, and it must also appear in a policy table, an audience map, a
timeout table, and a docs list. Each table is a separate file, and nothing
fails when one is missed. The failure surfaces later as a default-deny, an
invisible feature, or a wrong timeout.

A checklist in AGENTS.md ("adding a tool means touching these 7 places") is the
symptom, not the fix. Agents miss steps, and the checklist itself drifts.

## Option A — single declaration (preferred for new code)

Every fact about an entry lives in one object. Every table is derived from it.

```ts
// src/tools/define.ts
export interface ToolSpec {
	name: string;
	schema: JsonSchema;
	run: (args: unknown) => Promise<unknown>;
	policy: { risk: "low" | "medium" | "high"; rateLimitPerMin: number };
	audiences: Audience[];
	timeoutMs?: number;
}
export const defineTool = (spec: ToolSpec) => spec;

// src/tools/catalog.ts — the ONLY place a tool is listed
export const TOOLS = [readFileTool, writeFileTool, webFetchTool] as const;

// Derived tables: computed, never hand-maintained
export const POLICY_BY_TOOL = new Map(TOOLS.map((t) => [t.name, t.policy]));
export const TIMEOUT_BY_TOOL = new Map(TOOLS.map((t) => [t.name, t.timeoutMs ?? 30_000]));
```

The type system now enforces completeness. A tool without a policy doesn't
compile.

When a table must stay separate (it lives in another layer, or the security
team reviews it on its own), keep it separate but type it as
`Record<ToolName, X>`, where `ToolName` is derived from the catalog. A missing
key is then a compile error.

```ts
export type ToolName = (typeof TOOLS)[number]["name"];
export const ARI_ACTION: Record<ToolName, Action> = { read_file: "read", ... };
```

## Option B — completeness test (for existing tables)

When you can't restructure yet, one test loops over the registry and checks
every table. The failure message names the entry, the table, and the file to
edit, so the fix is mechanical.

```ts
const TABLES = [
	{ name: "policy", file: "src/tool-policy/policies.ts", has: (t: string) => POLICIES.has(t) },
	{ name: "audience", file: "src/tools/audience-map.ts", has: (t: string) => t in AUDIENCES },
	{ name: "action map", file: "src/exec/action-map.ts", has: (t: string) => t in ACTION_MAP },
];

it.each(allTools.map((t) => t.name))("%s is registered in every table", (tool) => {
	const missing = TABLES.filter((tbl) => !tbl.has(tool)).map((tbl) => `${tbl.name} (${tbl.file})`);
	expect(missing, `${tool} is missing from: ${missing.join(", ")}`).toEqual([]);
});
```

Also assert the reverse: no table has an entry for a tool that no longer exists.
Orphans are how removed features leave live policy behind.

## Finding the hidden registries

Search docs and comments for coupling written in prose:

```bash
grep -rniE "also (update|add|register|change)|don't forget|keep in sync|must match|every new|whenever you add" --include=*.md --include=*.ts --include=*.py .
```

Each hit is a candidate for Option A or B. Once the test exists, delete the
prose reminder and list the guard test in AGENTS.md's coupling section.
