import { describe, it, expect } from "vitest";
import { buildDeferredToolManifest } from "./tool-prompt-builder.js";
import type { ToolDefinition } from "../types.js";

function tool(name: string, description = `${name} does a thing.`): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  };
}

describe("buildDeferredToolManifest", () => {
  const all = [tool("read"), tool("write"), tool("computer"), tool("ocr"), tool("bash")];

  it("names every tool NOT loaded, and none that are loaded", () => {
    const loaded = [all[0], all[1], all[4]]; // read, write, bash
    const m = buildDeferredToolManifest(all, loaded);
    expect(m).toContain("- computer:");
    expect(m).toContain("- ocr:");
    expect(m).not.toMatch(/- read:/);
    expect(m).not.toMatch(/- write:/);
    expect(m).not.toMatch(/- bash:/);
  });

  it("upholds the invariant loaded ∪ manifested = all (no tool goes fully invisible)", () => {
    const loaded = [all[0]]; // only read
    const m = buildDeferredToolManifest(all, loaded);
    for (const t of all) {
      const inLoaded = loaded.some((l) => l.name === t.name);
      const inManifest = m.includes(`- ${t.name}:`);
      expect(inLoaded || inManifest).toBe(true);
    }
  });

  it("points the model at tool_search and forbids unsearched capability denial", () => {
    const m = buildDeferredToolManifest(all, [all[0]]);
    expect(m).toContain("tool_search");
    expect(m.toLowerCase()).toContain("never tell the user a capability is");
  });

  it("returns empty string when everything is already loaded", () => {
    expect(buildDeferredToolManifest(all, all)).toBe("");
    expect(buildDeferredToolManifest([], [])).toBe("");
  });

  it("shows the count of deferred tools in the header", () => {
    const m = buildDeferredToolManifest(all, [all[0], all[1]]); // 3 deferred
    expect(m).toContain("available on demand (3)");
  });

  it("uses only the first sentence of a long description", () => {
    const chatty = tool(
      "verbose",
      "Do the main thing. Then a whole paragraph of caveats that must not bloat the one-line manifest entry.",
    );
    const m = buildDeferredToolManifest([chatty], []);
    expect(m).toContain("- verbose: Do the main thing.");
    expect(m).not.toContain("caveats");
  });

  it("caps the list and DISCLOSES the overflow instead of silently dropping tools", () => {
    const many = Array.from({ length: 300 }, (_, i) => tool(`t${i}`));
    const m = buildDeferredToolManifest(many, []);
    expect(m).toContain("available on demand (300)"); // header counts ALL deferred
    expect(m).toContain("and 50 more"); // 300 − 250 cap
    expect(m).toContain("tool_search");
  });
});
