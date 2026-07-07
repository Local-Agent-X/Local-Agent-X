import { describe, it, expect } from "vitest";
import { findInBody, capBody } from "../src/tools/paginate-body.js";

describe("capBody", () => {
  it("returns the body unchanged when it fits", () => {
    expect(capBody("small", 100, "use find")).toBe("small");
  });

  it("truncates with a note pointing at the narrowing hint", () => {
    const r = capBody("a".repeat(200), 50, "the find param");
    expect(r).toContain("first 50 of 200 chars");
    expect(r).toContain("the find param");
    expect(r.endsWith("a".repeat(50))).toBe(true);
  });
});

describe("findInBody", () => {
  const page = [
    "Home page header",
    "About us section",
    "Our pricing starts at $49/mo",
    "Enterprise pricing on request",
    "Contact us at hello@example.com",
    "Footer links",
  ].join("\n");

  it("returns only lines matching the query plus context", () => {
    const r = findInBody(page, "pricing", 0);
    expect(r.matchCount).toBe(2);
    expect(r.text).toContain("Our pricing starts at $49/mo");
    expect(r.text).toContain("Enterprise pricing on request");
    expect(r.text).not.toContain("Home page header");
    expect(r.text).not.toContain("Footer links");
  });

  it("is case-insensitive", () => {
    expect(findInBody(page, "PRICING", 0).matchCount).toBe(2);
  });

  it("includes surrounding context lines and merges overlapping windows", () => {
    // The two 'pricing' lines are adjacent; context=1 merges them into one block.
    const r = findInBody(page, "pricing", 1);
    expect(r.text).toContain("About us section");   // context above first hit
    expect(r.text).toContain("Contact us at");       // context below second hit
    expect(r.text.match(/\[lines /g)?.length).toBe(1); // one merged block, not two
  });

  it("reports no match cleanly", () => {
    const r = findInBody(page, "refund policy", 0);
    expect(r.matchCount).toBe(0);
    expect(r.text).toContain("No lines matching");
  });

  it("returns the body unchanged for an empty query", () => {
    expect(findInBody(page, "", 0).text).toBe(page);
  });

  it("caps the number of blocks and tells the agent to refine", () => {
    // Non-adjacent matches (a filler line between each) so they don't merge into
    // one block — 200 separate matches → 200 blocks, capped at 50.
    const many = Array.from({ length: 200 }, (_, i) => `match ${i}\nfiller`).join("\n");
    const r = findInBody(many, "match", 0, 50);
    expect(r.matchCount).toBe(200);
    expect(r.text).toContain("showing the first 50 of 200 blocks");
    expect(r.text).toContain("refine the query");
  });

  it("merges adjacent matches into a single block", () => {
    const consecutive = Array.from({ length: 10 }, (_, i) => `match ${i}`).join("\n");
    const r = findInBody(consecutive, "match", 0);
    expect(r.matchCount).toBe(10);
    expect(r.text.match(/\[lines /g)?.length).toBe(1);
  });
});
