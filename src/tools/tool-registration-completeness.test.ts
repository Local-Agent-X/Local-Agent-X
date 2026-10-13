// Registration completeness over the RUNTIME tool catalog.
//
// A tool is registered in several hand-maintained tables, and the older
// coverage tests sourced their names from `allTools` — a minority of tools.
// Everything that registers through a plugin (`setting`, `http_request`, the
// memory, browser, agent and protocol families, …) was invisible to them, so
// a plugin tool with no policy entry or kernel class would pass CI and hit
// default-deny (policy) or fail-closed (kernel) the first time a user called
// it. This test walks the catalog the way boot does and checks the two tables
// whose absence blocks a tool outright. The failure message names the table
// and the file to edit.
//
// Tables with their own forward checks, not repeated here: Ari action map
// (ari-action-map.test.ts), EGRESS_TOOLS ⇔ offBoxFetch
// (capability-class-gates.test.ts), the write family (write-family-drift),
// session-scoped `_sessionId` readers (session-scoped-tools.test.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { collectRuntimeToolNames } from "./runtime-tool-names.js";
import { allTools } from "./registry-build.js";
import { ToolPolicy, auditPolicyCoverage } from "../tool-policy/index.js";
import { DEFAULT_POLICY } from "../tool-policy/default-rules.js";
import { auditKernelCoverage } from "../ari-kernel/coverage.js";

let names: string[];

beforeAll(async () => {
  names = [...(await collectRuntimeToolNames())].sort();
});

describe("every runtime tool, plugins included, is fully registered", () => {
  it("the catalog is wider than allTools (otherwise this test proves nothing)", () => {
    expect(names.length).toBeGreaterThan(allTools.length);
    for (const pluginTool of ["setting", "http_request", "browser", "memory_search", "agent_spawn"]) {
      expect(names, `${pluginTool} should come from a plugin`).toContain(pluginTool);
    }
  });

  it("has a covering policy rule — a tool without one is default-denied", () => {
    const report = auditPolicyCoverage(names, new ToolPolicy(DEFAULT_POLICY));
    expect(
      report.uncovered,
      `no policy rule covers: ${report.uncovered.join(", ")} — add an entry to the matching ` +
        `src/tool-policy/tool-policies.<domain>.ts fragment (kernel, risk, pathArgs if it takes a path, an allow-<name> rule)`,
    ).toEqual([]);
  });

  it("has a kernel class — a tool without one fails closed in the Ari gate", () => {
    const report = auditKernelCoverage(names);
    expect(
      report.uncovered,
      `no kernel class for: ${report.uncovered.join(", ")} — set \`kernel\` on its policy entry ` +
        `(file / http / shell / database / retrieval / secret-vault, or "internal" to skip Ari)`,
    ).toEqual([]);
  });
});
