// The catalog the coverage tests check is built by the walk boot itself makes
// over the plugins (register-plugins.ts). It was a second loop written
// for the tests, which skipped what boot does to a plugin's tools: it never
// stamped their audiences, and a rule added to boot would not have reached it.
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../types.js";
import { AUDIENCES_BY_TOOL } from "./audience-map.js";
import { allTools } from "./registry-build.js";
import { collectRuntimeTools } from "./runtime-tool-names.js";

let catalog: Map<string, ToolDefinition>;
beforeAll(async () => { catalog = await collectRuntimeTools(); }, 120_000);

describe("collectRuntimeTools", () => {
  it("holds the core tools and the tools only a plugin registers", () => {
    for (const tool of allTools) expect(catalog.has(tool.name), tool.name).toBe(true);
    for (const name of ["setting", "http_request", "mission_schedule_create", "agent_spawn"]) expect(catalog.has(name), name).toBe(true);
  });

  it("gives a plugin's tool the audiences boot gives it", () => {
    const core = new Set(allTools.map((t) => t.name));
    const fromPlugins = Object.keys(AUDIENCES_BY_TOOL).filter((name) => catalog.has(name) && !core.has(name));
    expect(fromPlugins.length).toBeGreaterThan(10);
    for (const name of fromPlugins) expect(catalog.get(name)!.audiences, name).toEqual(AUDIENCES_BY_TOOL[name]);
  });
});
