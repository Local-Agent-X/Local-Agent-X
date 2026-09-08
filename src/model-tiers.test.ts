/**
 * Tier-compact tool schemas (src/model-tiers.ts: shrinkToolsForTier).
 *
 * The medium-tier manifest — the ESSENTIAL_TOOLS_ORDER set plus the two
 * intent slots — went to a 65k local model at ~13.6k tokens (~590 per tool),
 * nearly all of it Claude-length prose. This pins the class fix: every tool
 * may carry a `compactDescription` that medium AND weak tiers ship instead,
 * parameter descriptions over COMPACT_PARAM_DESCRIPTION_MAX chars are
 * shortened, and the strong tier is byte-for-byte untouched. Sizes are
 * measured with the SAME estimator the request-fit gate uses
 * (toolManifestTokens) over the wire shape the adapters send
 * ({name, description, parameters}) so the number here is the number the
 * model actually pays.
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_PARAM_DESCRIPTION_MAX,
  ESSENTIAL_TOOLS_ORDER,
  compactSchemaDescriptions,
  shrinkToolsForTier,
} from "./model-tiers.js";
import { toolManifestTokens } from "./context-manager/request-fit.js";
import { collectArgViolations } from "./tool-execution/arg-validation.js";
import { allTools } from "./tools/registry-build.js";
import { createMemoryTools } from "./memory/tools.js";
import { createCronTools } from "./cron/tools.js";
import { createBrowserTools } from "./tools/browser-tools/index.js";
import { createHttpRequestTool } from "./tools/http-request.js";
import { imageTools } from "./tools/image-tools/index.js";
import type { ToolDefinition } from "./types.js";

/** Authored bound on a compact description (ToolDefinition.compactDescription). */
const COMPACT_MAX = 220;

/** The live medium set from the "[tools] Shrunk 63→23" log line: the essentials
 *  plus the intent-slot tools that turn actually admitted. */
const MEDIUM_SET = [
  ...ESSENTIAL_TOOLS_ORDER,
  "edit_lines", "multi_edit", "mission_schedule_list", "mission_schedule_create",
];

/** Real catalog objects. Memory/cron factories only close over their
 *  dependency (used inside execute), so a stub is enough to read schemas. */
function realCatalog(): ToolDefinition[] {
  const stub = {} as never;
  return [
    ...allTools,
    ...createMemoryTools(stub),
    ...createCronTools(stub),
    ...createBrowserTools(),
    createHttpRequestTool(),
    ...imageTools,
  ];
}

function mediumSet(): ToolDefinition[] {
  const catalog = realCatalog();
  return MEDIUM_SET.map((name) => {
    const t = catalog.find((c) => c.name === name);
    if (!t) throw new Error(`medium-set tool missing from catalog: ${name}`);
    return t;
  });
}

/** What the provider adapters put on the wire (openai-compat / codex / gemini). */
const wire = (t: { name: string; description: string; parameters?: Record<string, unknown> }) =>
  ({ name: t.name, description: t.description, parameters: t.parameters });

/** Deep copy with every `description` key removed — the validation-bearing skeleton. */
function skeleton(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(skeleton);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = skeleton(val);
    }
    return out;
  }
  return v;
}

function walkDescriptions(schema: unknown, visit: (desc: string) => void): void {
  if (!schema || typeof schema !== "object") return;
  const o = schema as Record<string, unknown>;
  if (typeof o.description === "string") visit(o.description);
  if (o.properties && typeof o.properties === "object") {
    for (const v of Object.values(o.properties as Record<string, unknown>)) walkDescriptions(v, visit);
  }
  if (o.items) walkDescriptions(o.items, visit);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(o[key])) for (const b of o[key] as unknown[]) walkDescriptions(b, visit);
  }
}

describe("compactDescription — authored coverage for the medium set", () => {
  it("every medium-set tool ships a description of at most 220 chars to a medium model", () => {
    for (const t of mediumSet()) {
      const shipped = t.compactDescription ?? t.description;
      expect(shipped.length, `${t.name}: ${shipped.length} chars`).toBeLessThanOrEqual(COMPACT_MAX);
    }
  });

  it("keeps the safety rules a compact text must not drop", () => {
    const byName = new Map(mediumSet().map((t) => [t.name, t.compactDescription ?? t.description]));
    expect(byName.get("bash")).toMatch(/POSIX sh/);
    expect(byName.get("bash")).toMatch(/env\/credential/i);
    expect(byName.get("write")).toMatch(/2000 chars/);
    expect(byName.get("edit")).toMatch(/content must match/i);
    expect(byName.get("read")).toMatch(/do NOT chunk/);
    expect(byName.get("multi_edit")).toMatch(/ATOMICALLY/);
    expect(byName.get("generate_video")).toMatch(/never call send_video/);
    expect(byName.get("self_edit")).toMatch(/developer_mode/);
    expect(byName.get("remember")).toMatch(/provenance/);
    expect(byName.get("browser")).toMatch(/screen_capture/);
  });
});

describe("shrinkToolsForTier — medium manifest size", () => {
  it("is at least 50% smaller than the full-text manifest and under the measured ceiling", () => {
    const set = mediumSet();
    const before = toolManifestTokens(set.map(wire));
    const shrunk = shrinkToolsForTier(set, "medium", set, set.length);
    const after = toolManifestTokens(shrunk.map(wire));
    expect(shrunk.map((t) => t.name)).toEqual(set.map((t) => t.name));
    // Measured 2026-09-07 over these 25 tools: 14,030 → 6,352 (55% smaller);
    // the 23-tool cap set went 13,653 → 6,100. The full-text baseline is pinned
    // loosely so the assertion means "compaction still buys ≥50%", not "the
    // catalog never grows".
    expect(before).toBeGreaterThan(12_000);
    expect(after).toBeLessThanOrEqual(before / 2);
    expect(after).toBeLessThanOrEqual(7_000);
  });

  it("shortens parameter descriptions past the cap and leaves shorter ones verbatim", () => {
    const set = mediumSet();
    const shrunk = shrinkToolsForTier(set, "medium", set, set.length);
    let shortened = 0;
    for (const t of shrunk) {
      walkDescriptions(t.parameters, (d) => {
        expect(d.length, `${t.name} param description`).toBeLessThanOrEqual(COMPACT_PARAM_DESCRIPTION_MAX);
      });
    }
    for (const t of set) walkDescriptions(t.parameters, (d) => { if (d.length > COMPACT_PARAM_DESCRIPTION_MAX) shortened++; });
    expect(shortened).toBeGreaterThan(0); // the cap is doing work on the real catalog
  });
});

describe("shrinkToolsForTier — schemas still validate", () => {
  it("keeps every type / enum / required / items key byte-identical (only prose changes)", () => {
    const set = mediumSet();
    const shrunk = shrinkToolsForTier(set, "medium", set, set.length);
    for (let i = 0; i < set.length; i++) {
      expect(skeleton(shrunk[i].parameters)).toEqual(skeleton(set[i].parameters));
    }
  });

  it("the arg validator gives the same verdicts on the compact schema", () => {
    const set = mediumSet();
    const shrunk = shrinkToolsForTier(set, "medium", set, set.length);
    type Schema = Parameters<typeof collectArgViolations>[1];
    const browserFull = set.find((t) => t.name === "browser")!.parameters as Schema;
    const browserCompact = shrunk.find((t) => t.name === "browser")!.parameters as Schema;
    const good = { action: "navigate", url: "https://example.com" };
    const bad = { action: "teleport", ref: "5" };
    expect(collectArgViolations(good, browserCompact)).toEqual([]);
    expect(collectArgViolations(bad, browserCompact)).toEqual(collectArgViolations(bad, browserFull));
    expect(collectArgViolations(bad, browserCompact).length).toBeGreaterThan(0);
  });

  it("never mutates the shared catalog object", () => {
    const set = mediumSet();
    const snapshot = JSON.stringify(set.map(wire));
    shrinkToolsForTier(set, "medium", set, set.length);
    shrinkToolsForTier(set, "weak", set);
    expect(JSON.stringify(set.map(wire))).toBe(snapshot);
  });
});

describe("shrinkToolsForTier — tier fallbacks", () => {
  const long = "Long tool description. ".repeat(20).trim(); // > 150 chars, first sentence short
  const longParam = "A parameter description that runs well past the compaction cap so the schema shrinker has something to do here. Second sentence.";
  const mk = (over: Partial<{ compactDescription: string }> = {}) => ({
    name: "t",
    description: long,
    parameters: { type: "object", properties: { x: { type: "string", description: longParam } }, required: ["x"] },
    ...over,
  });

  it("strong: same objects back, byte-for-byte", () => {
    const tools = [mk({ compactDescription: "Compact." }), mk()];
    const out = shrinkToolsForTier(tools, "strong");
    expect(out[0]).toBe(tools[0]);
    expect(out[1]).toBe(tools[1]);
    expect(JSON.stringify(out)).toBe(JSON.stringify(tools));
  });

  it("medium: compactDescription when present, the full description when absent", () => {
    const [withCompact, without] = shrinkToolsForTier([mk({ compactDescription: "Compact." }), mk()], "medium");
    expect(withCompact.description).toBe("Compact.");
    expect(without.description).toBe(long);
  });

  it("weak: compactDescription when present, the historical first-sentence truncation when absent", () => {
    const [withCompact, without] = shrinkToolsForTier([mk({ compactDescription: "Compact." }), mk()], "weak");
    expect(withCompact.description).toBe("Compact.");
    expect(without.description).toBe("Long tool description.");
  });

  it("medium and weak both compact parameter prose; a tool with no parameters is fine", () => {
    for (const tier of ["medium", "weak"] as const) {
      const [t] = shrinkToolsForTier([mk()], tier);
      const x = (t.parameters!.properties as Record<string, { description: string }>).x;
      expect(x.description.length).toBeLessThanOrEqual(COMPACT_PARAM_DESCRIPTION_MAX);
      expect(x.description.startsWith("A parameter description")).toBe(true);
      const [bare] = shrinkToolsForTier([{ name: "bare", description: "Short." }], tier);
      expect(bare).toEqual({ name: "bare", description: "Short.", parameters: undefined });
    }
  });
});

describe("compactSchemaDescriptions", () => {
  it("recurses into items and anyOf branches and copies rather than mutates", () => {
    const longDesc = "x".repeat(130) + ". tail";
    const schema = {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string", description: longDesc } },
        either: { anyOf: [{ type: "string", description: longDesc }, { type: "number" }] },
      },
      required: ["list"],
    };
    const out = compactSchemaDescriptions(schema);
    const items = (out.properties as Record<string, { items: { description: string } }>).list.items;
    const branch = (out.properties as Record<string, { anyOf: Array<{ description?: string }> }>).either.anyOf[0];
    expect(items.description.length).toBeLessThanOrEqual(COMPACT_PARAM_DESCRIPTION_MAX);
    expect(branch.description!.length).toBeLessThanOrEqual(COMPACT_PARAM_DESCRIPTION_MAX);
    expect((schema.properties.list.items as { description: string }).description).toBe(longDesc);
    expect(skeleton(out)).toEqual(skeleton(schema));
  });
});
