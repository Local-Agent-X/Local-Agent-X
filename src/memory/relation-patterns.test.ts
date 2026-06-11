import { describe, it, expect } from "vitest";
import { extractRelationTriples } from "./relation-patterns.js";

describe("extractRelationTriples", () => {
  it("pulls clean objects, trimming run-on trailing clauses", () => {
    const triples = extractRelationTriples(
      "Alex works at Initech and lives in Dallas.",
      ["Alex"]
    );
    const works = triples.find((t) => t.predicate === "works");
    expect(works?.object).toBe("Initech");
    // no triple should carry a run-on object glued by "and"
    expect(triples.every((t) => !/\band\b/.test(t.object))).toBe(true);
  });

  it("covers the parity verbs (competes, depends)", () => {
    const preds = extractRelationTriples(
      "Kraken bot depends on the Kraken API. It competes with other trading bots.",
      ["Kraken"]
    ).map((t) => t.predicate);
    expect(preds).toContain("depends");
    expect(preds).toContain("competes");
  });

  it("falls back to the first known entity for filler subjects", () => {
    const triples = extractRelationTriples("It uses Node.", ["Alex"]);
    expect(triples[0]).toMatchObject({ subject: "Alex", predicate: "uses", object: "Node" });
  });
});
