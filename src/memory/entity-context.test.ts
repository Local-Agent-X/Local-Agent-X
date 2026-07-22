/**
 * Tests for inline entity-fact recall in <known_entities> (entity-context.ts).
 *
 * The free recall path: a message mentioning a known entity gets that
 * entity's facts rendered inline instead of a bare name list — no
 * memory_search tool round-trip. Regressions guarded here:
 *   - facts already rendered in <core_memory> this turn must NOT repeat
 *     in <known_entities> (dedup falls back to the legacy bare name list)
 *   - the byte cap degrades a too-big entity block to a bare name, never
 *     a mid-fact truncation
 *   - every rendered turn appends one restart-safe JSONL telemetry event
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import { buildContextBlock } from "./context.js";
import { getLaxDir } from "../lax-data-dir.js";
import {
  renderKnownEntitiesBody,
  findCutoffMisses,
  type EntityScanResult,
} from "./entity-context.js";
import type { RetainedFact } from "./types.js";

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-entity-ctx-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function extractKnownEntities(block: string): string {
  const m = block.match(/<known_entities>[\s\S]*?<\/known_entities>/);
  return m ? m[0] : "";
}

function makeFact(id: number, content: string, entities: string[] = []): RetainedFact {
  return {
    id, kind: "world", content, entities, confidence: 1.0,
    evidenceFor: [], evidenceAgainst: [], sourceFile: "test.md", sourceLine: 1,
    timestamp: Date.now(), lastUpdated: Date.now(),
  };
}

function makeScan(overrides: Partial<EntityScanResult>): EntityScanResult {
  return {
    mentionedEntities: [], entityFacts: new Map(), scannedSlugs: new Set(),
    totalEntities: 0, scannedEntities: 0, ...overrides,
  };
}

describe("inline entity facts in <known_entities>", () => {
  it("renders a fact excluded from <core_memory> inline when its entity is mentioned", async () => {
    // confidence 0.3 < core_memory's minConfidence 0.4 → the fact is
    // invisible to <core_memory>, so inline recall is its only free path.
    const r = memory.rememberFact(
      "Merchhelm is the Shopify merch storefront project @merchhelm",
      { kind: "world", confidence: 0.3 },
    );
    expect(r.ok).toBe(true);

    const block = await buildContextBlock(memory, {
      skipDailyLog: true,
      userMessage: "what is merchhelm?",
    });
    const known = extractKnownEntities(block);

    expect(known).toContain("merchhelm:");
    expect(known).toContain("Merchhelm is the Shopify merch storefront project");
    expect(known).toContain("recall, not proof");
    expect(block.match(/<core_memory>[\s\S]*?<\/core_memory>/)?.[0] ?? "")
      .not.toContain("Merchhelm is the Shopify merch storefront project");
  });

  it("does not repeat a fact <core_memory> already rendered — falls back to the legacy bare name list", async () => {
    const r = memory.rememberFact(
      "Bookwell is the reading tracker app @bookwell",
      { kind: "world", confidence: 1.0 },
    );
    expect(r.ok).toBe(true);

    const block = await buildContextBlock(memory, {
      skipDailyLog: true,
      userMessage: "how is bookwell going?",
    });

    // Rendered once in core_memory…
    expect(block.match(/<core_memory>[\s\S]*?<\/core_memory>/)?.[0] ?? "")
      .toContain("Bookwell is the reading tracker app");
    // …and NOT again in known_entities, which degrades to the bare list.
    const known = extractKnownEntities(block);
    expect(known).toContain("bookwell");
    expect(known).not.toContain("Bookwell is the reading tracker app");
    expect(known).not.toContain("bookwell:");
  });

  it("appends a restart-safe telemetry event for the rendered turn", async () => {
    memory.rememberFact("Merchhelm sells parody tees @merchhelm", { kind: "world", confidence: 0.3 });

    await buildContextBlock(memory, { skipDailyLog: true, userMessage: "merchhelm status" });

    const file = join(getLaxDir(), "telemetry", "memory-recall.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.matched).toContain("merchhelm");
    expect(event.factsRendered).toBeGreaterThanOrEqual(1);
    expect(event.bytesInjected).toBeGreaterThan(0);
    expect(typeof event.ts).toBe("string");
  });
});

describe("renderKnownEntitiesBody", () => {
  it("byte cap degrades an overflowing entity block to a bare name, never a truncated fact", () => {
    const scan = makeScan({
      mentionedEntities: ["bigentity"],
      entityFacts: new Map([["bigentity", [makeFact(1, "x".repeat(500))]]]),
    });
    const render = renderKnownEntitiesBody(scan, new Set(), 60);
    expect(render.factsRendered).toBe(0);
    expect(render.body).toBe("bigentity");

    const roomy = renderKnownEntitiesBody(scan, new Set(), 10_000);
    expect(roomy.factsRendered).toBe(1);
    expect(roomy.body).toContain("bigentity:");
  });

  it("mixes fact blocks and deduped bare names", () => {
    const scan = makeScan({
      mentionedEntities: ["alpha", "beta"],
      entityFacts: new Map([
        ["alpha", [makeFact(1, "alpha is a project")]],
        ["beta", [makeFact(2, "beta is a tool")]],
      ]),
    });
    const render = renderKnownEntitiesBody(scan, new Set([2]), 10_000);
    expect(render.factsRendered).toBe(1);
    expect(render.factsDeduped).toBe(1);
    expect(render.body).toContain("alpha:");
    expect(render.body).toContain("alpha is a project");
    expect(render.body).toContain("also mentioned: beta");
    expect(render.body).not.toContain("beta is a tool");
  });

  it("with nothing to render, the body is byte-identical to the legacy name list", () => {
    const scan = makeScan({
      mentionedEntities: ["one", "two"],
      entityFacts: new Map([["one", [makeFact(1, "fact one")]], ["two", []]]),
    });
    const render = renderKnownEntitiesBody(scan, new Set([1]), 10_000);
    expect(render.body).toBe("one, two");
    expect(render.factsRendered).toBe(0);
  });
});

describe("findCutoffMisses", () => {
  it("reports a slug that word-matches the message but sits past the scan window", () => {
    memory.rememberFact("Zzslug is an obscure side project @zzslug", { kind: "world", confidence: 0.9 });
    const scan = makeScan({
      scannedSlugs: new Set(["somethingelse"]),
      totalEntities: 300,
      scannedEntities: 200,
    });
    expect(findCutoffMisses(memory, "tell me about zzslug", scan)).toEqual(["zzslug"]);
  });

  it("returns nothing when the scan window covered every entity", () => {
    memory.rememberFact("Zzslug is an obscure side project @zzslug", { kind: "world", confidence: 0.9 });
    const scan = makeScan({
      scannedSlugs: new Set(["zzslug"]),
      totalEntities: 1,
      scannedEntities: 1,
    });
    expect(findCutoffMisses(memory, "tell me about zzslug", scan)).toEqual([]);
  });
});
