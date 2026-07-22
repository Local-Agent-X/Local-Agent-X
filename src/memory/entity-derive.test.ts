/**
 * Tests for code-derived fact entities (entity-derive.ts).
 *
 * The regression class: entity indexing depended on model-typed @-tags,
 * models don't type them, so 91% of facts had zero entity links and name
 * recognition was blind (the "merchhelm" bug — three facts about the
 * product, none reachable by name). Derivation must work from content
 * alone, deterministically, with junk slugs rejected at the seam.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";
import {
  deriveEntitySlugs,
  validateEntitySlug,
  backfillEntityLinks,
} from "./entity-derive.js";

const NONE: ReadonlySet<string> = new Set();

describe("validateEntitySlug", () => {
  it("rejects junk: short, numeric, stopword; accepts real names", () => {
    for (const junk of ["p", "mj", "5", "42", "may", "user", "the"]) {
      expect(validateEntitySlug(junk), junk).toBe(false);
    }
    for (const ok of ["merchhelm", "clover", "nutrishop", "sipdirty805"]) {
      expect(validateEntitySlug(ok), ok).toBe(true);
    }
  });
});

describe("deriveEntitySlugs", () => {
  it("derives the merchhelm entities from untagged content, subject first", () => {
    const slugs = deriveEntitySlugs(
      "User wants to build Merchhelm as Clover-native AI inventory operator that replaces Shopventory",
      [],
      NONE,
    );
    expect(slugs[0]).toBe("merchhelm");
    expect(slugs).toContain("clover");
    expect(slugs).toContain("shopventory");
  });

  it("keeps explicit @-tags first and rejects junk tags", () => {
    const slugs = deriveEntitySlugs("Something about the shop", ["Sam", "p", "mj"], NONE);
    expect(slugs).toEqual(["sam"]);
  });

  it("excludes sentence-initial plain capitalized words unless already known", () => {
    const content = "Merchhelm is the chosen product name.";
    expect(deriveEntitySlugs(content, [], NONE)).toEqual([]);
    expect(deriveEntitySlugs(content, [], new Set(["merchhelm"]))).toEqual(["merchhelm"]);
  });

  it("accepts name-shaped tokens anywhere: CamelCase and letter+digit coinages", () => {
    expect(deriveEntitySlugs("StockPilot was already taken.", [], NONE)).toContain("stockpilot");
    expect(deriveEntitySlugs("The handle sipdirty805 posts daily.", [], NONE)).toContain("sipdirty805");
  });

  it("excludes ALL-CAPS acronyms and calendar words", () => {
    const slugs = deriveEntitySlugs("The MVP ships in May with GLP support.", [], NONE);
    expect(slugs).toEqual([]);
  });

  it("strips possessives and compound-modifier tails", () => {
    expect(deriveEntitySlugs("The store is part of Peter's empire.", [], NONE)).toContain("peter");
    expect(deriveEntitySlugs("It uses a Clover-native sync layer.", [], NONE)).toContain("clover");
  });

  it("does not coin entities from Title Case heading runs or prose words — the snowball regression", () => {
    // Real corpus shape that poisoned the first backfill attempt: heading
    // runs ("Google App Approval Friction") and capitalized prose words
    // whose lowercase form appears in the same content ("Inventory" vs
    // "inventory system") coined junk entities, which then case-free-linked
    // into hundreds of unrelated facts.
    const slugs = deriveEntitySlugs(
      "Google App Approval Friction (2026-04-27): the inventory system tracks Inventory across the GLP-1 / Weight Loss Nutrition Support display.",
      [],
      NONE,
    );
    // glp-1 survives deliberately: digit-bearing coinages are name-shaped
    // (it's a real product term, and it only ever links on exact matches).
    expect(slugs).toEqual(["glp-1"]);
  });

  it("links known slugs only on capitalized occurrences (digit coinages case-free)", () => {
    const known = new Set(["kraken", "sipdirty805"]);
    // Lowercase "kraken" must NOT link even though 'kraken' is a known slug —
    // case-free linking is how one generic entity snowballs across the corpus.
    expect(deriveEntitySlugs("The kraken strategy needs review.", [], known)).toEqual([]);
    expect(deriveEntitySlugs("The Kraken bot trades daily.", [], known)).toEqual(["kraken"]);
    expect(deriveEntitySlugs("posts from sipdirty805 daily", [], known)).toEqual(["sipdirty805"]);
  });

  it("rejects generic tech/prose nouns as entities", () => {
    for (const generic of ["app", "tool", "project", "memory", "build", "session"]) {
      expect(validateEntitySlug(generic), generic).toBe(false);
    }
  });

  it("caps the slug count per fact", () => {
    const content = "It links Alpha1 Beta2 Gamma3 Delta4 Epsilon5 Zeta6 Eta7 Theta8 Iota9 Kappa10 together.";
    expect(deriveEntitySlugs(content, [], NONE).length).toBeLessThanOrEqual(8);
  });
});

describe("write-seam integration (retain path)", () => {
  let tempDir: string;
  let memory: MemoryIndex;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lax-derive-"));
    mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
    memory = new MemoryIndex(tempDir, { minScore: -1 });
    authorizeTestFactMutations(memory);
  });

  afterEach(() => {
    try { memory.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("an untagged remember() is reachable via recallByEntity — the merchhelm regression", () => {
    const r = memory.rememberFact(
      "User wants to build Merchhelm as a Clover-native inventory operator",
      { kind: "observation", confidence: 0.8 },
    );
    expect(r.ok).toBe(true);
    expect(r.fact!.entities[0]).toBe("merchhelm");

    const recalled = memory.recallByEntity("merchhelm");
    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toContain("Merchhelm");
  });

  it("junk @-tags no longer create junk entities", () => {
    const r = memory.rememberFact("A note that mentions @p and @mj as tags", { confidence: 0.9 });
    expect(r.ok).toBe(true);
    expect(memory.recallByEntity("p")).toHaveLength(0);
    expect(memory.recallByEntity("mj")).toHaveLength(0);
  });
});

describe("backfillEntityLinks (schema v13)", () => {
  let tempDir: string;
  let memory: MemoryIndex;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lax-backfill-"));
    mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
    memory = new MemoryIndex(tempDir, { minScore: -1 });
    authorizeTestFactMutations(memory);
  });

  afterEach(() => {
    try { memory.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // Simulate legacy rows: facts written under the tag-only contract, with
  // no entity_mentions and an empty entities column.
  function insertLegacyFact(content: string, kind = "observation"): number {
    const db = memory["db"];
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
         source_file, source_line, timestamp, last_updated)
         VALUES (?, ?, '[]', 1.0, '[]', '[]', 'legacy-test', 0, ?, ?)`
      )
      .run(kind, content, now, now);
    return r.lastInsertRowid as number;
  }

  it("links legacy untagged facts and purges junk mentions", () => {
    const db = memory["db"];
    const merchId = insertLegacyFact(
      "User selected Merchhelm after StockPilot and MerchOS were already in use.",
    );
    const junkHost = insertLegacyFact("Legacy fact that carried junk tags.");
    db.prepare("INSERT INTO entity_mentions (fact_id, entity_slug) VALUES (?, 'p')").run(junkHost);
    db.prepare("INSERT INTO entity_mentions (fact_id, entity_slug) VALUES (?, 'mj')").run(junkHost);

    const result = backfillEntityLinks(db);

    expect(result.junkMentionsRemoved).toBe(2);
    expect(result.factsLinked).toBeGreaterThanOrEqual(1);
    const slugs = (db
      .prepare("SELECT entity_slug FROM entity_mentions WHERE fact_id = ?")
      .all(merchId) as Array<{ entity_slug: string }>)
      .map((r) => r.entity_slug);
    expect(slugs).toContain("merchhelm");
    expect(slugs).toContain("stockpilot");
    // The entities column is kept consistent with the link table.
    const col = db.prepare("SELECT entities FROM facts WHERE id = ?").get(merchId) as { entities: string };
    expect(JSON.parse(col.entities)).toContain("merchhelm");
  });

  it("pass 2 links a sentence-initial-only mention via an entity coined by a later fact", () => {
    const db = memory["db"];
    // Earlier fact: "Merchhelm" appears ONLY sentence-initial — pass 1 skips it.
    const early = insertLegacyFact("Merchhelm is the chosen product name.");
    // Later fact coins the entity mid-sentence.
    insertLegacyFact("User wants to ship Merchhelm this quarter.");

    backfillEntityLinks(db);

    const slugs = (db
      .prepare("SELECT entity_slug FROM entity_mentions WHERE fact_id = ?")
      .all(early) as Array<{ entity_slug: string }>)
      .map((r) => r.entity_slug);
    expect(slugs).toContain("merchhelm");
  });

  it("is idempotent — a second run adds nothing", () => {
    const db = memory["db"];
    insertLegacyFact("User wants to ship Merchhelm this quarter.");
    backfillEntityLinks(db);
    const second = backfillEntityLinks(db);
    expect(second.factsLinked).toBe(0);
    expect(second.mentionsAdded).toBe(0);
    expect(second.junkMentionsRemoved).toBe(0);
  });
});
