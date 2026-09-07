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

  // C6c - family grouping. The manifest was 10,715 B for 113 deferred tools on
  // the real catalog, 83% of the whole tool-guidance section, re-sent uncached
  // every turn. Grouping drops DESCRIPTIONS the shared prefix already implies;
  // it must never drop a NAME, or a tool becomes unfindable.
  describe("family grouping", () => {
    const family = [
      tool("email_send"), tool("email_read"), tool("email_search"),
      tool("sql_query"), tool("sql_schema"),
      tool("ocr", "Extract text from an image using OCR (Tesseract)."),
      tool("doctor", "Run system self-diagnostics."),
    ];

    it("NAMES every deferred tool exactly once, grouped or not (discoverability)", () => {
      const m = buildDeferredToolManifest(family, []);
      for (const t of family) {
        const hits = m.split(t.name).length - 1;
        expect(hits, `${t.name} must appear exactly once`).toBe(1);
      }
    });

    it("collapses a family to one names-only line and drops its descriptions", () => {
      const m = buildDeferredToolManifest(family, []);
      expect(m).toContain("- email_*: email_send, email_read, email_search");
      expect(m).toContain("- sql_*: sql_query, sql_schema");
      expect(m).not.toContain("email_send does a thing");
      expect(m).not.toContain("sql_query does a thing");
    });

    it("keeps the one-liner for a tool with no family - a lone name says nothing", () => {
      const m = buildDeferredToolManifest(family, []);
      expect(m).toContain("- ocr: Extract text from an image using OCR (Tesseract).");
      expect(m).toContain("- doctor: Run system self-diagnostics.");
    });

    it("does not group a one-member prefix", () => {
      const m = buildDeferredToolManifest([tool("email_send"), tool("ocr")], []);
      expect(m).not.toContain("email_*");
      expect(m).toContain("- email_send:");
    });

    it("tells the model how to read a grouped line, and to search before denying", () => {
      const m = buildDeferredToolManifest(family, []);
      expect(m).toContain("prefix_*: a, b, c");
      expect(m.toLowerCase()).toContain("never tell the user a capability is");
      expect(m).toContain("tool_search");
    });

    it("is materially smaller than one described line per tool", () => {
      const desc = "A long first sentence that would otherwise be repeated twenty times over.";
      // Same tool count, same descriptions; only whether they share a prefix.
      const groupable = Array.from({ length: 20 }, (_, i) => tool(`email_${i}`, desc));
      const ungroupable = Array.from({ length: 20 }, (_, i) => tool(`solo${i}`, desc));
      const grouped = buildDeferredToolManifest(groupable, []);
      const flat = buildDeferredToolManifest(ungroupable, []);
      expect(grouped.length).toBeLessThan(flat.length / 2);
    });
  });

  it("caps the list and DISCLOSES the overflow instead of silently dropping tools", () => {
    const many = Array.from({ length: 300 }, (_, i) => tool(`t${i}`));
    const m = buildDeferredToolManifest(many, []);
    expect(m).toContain("available on demand (300)"); // header counts ALL deferred
    expect(m).toContain("and 50 more"); // 300 − 250 cap
    expect(m).toContain("tool_search");
  });
});
