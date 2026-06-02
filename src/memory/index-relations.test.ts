import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { applyGraphBoost } from "./index-search/post-process.js";
import type { MemorySearchResult } from "./types.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-rel-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("wikilink edges", () => {
  it("promotes [[name]] links into traversable links-to edges", () => {
    memory.extractRelations("Peter ships [[ScanProgress]] and [[Kraken]]", ["Peter"]);

    const rels = memory.getRelationsFor("ScanProgress");
    expect(rels.some((r) => r.predicate === "links-to")).toBe(true);

    const reach = memory.traverseFrom("Peter", 2);
    expect(reach.has("scanprogress")).toBe(true);
    expect(reach.has("kraken")).toBe(true);
  });

  it("links co-linked targets even with no tagged entity", () => {
    memory.extractRelations("see [[alpha]] and [[beta]]", []);
    const reach = memory.traverseFrom("alpha", 1);
    expect(reach.has("beta")).toBe(true);
  });
});

describe("graph boost", () => {
  it("lifts results whose entity is graph-connected to a query term", () => {
    memory.extractRelations("Peter ships [[Kraken]]", ["Peter"]);

    const base = { startLine: 0, endLine: 0, snippet: "", source: "entity" as const, metadata: {} };
    const results: MemorySearchResult[] = [
      { ...base, path: "a.md", score: 0.5, entities: ["kraken"] },
      { ...base, path: "b.md", score: 0.5, entities: ["unrelated"] },
    ];

    const boosted = applyGraphBoost(
      (e, h) => memory.traverseFrom(e, h),
      results,
      "Peter Kraken",
    );

    const kraken = boosted.find((r) => r.path === "a.md")!;
    const other = boosted.find((r) => r.path === "b.md")!;
    expect(kraken.score).toBeGreaterThan(other.score);
  });
});
