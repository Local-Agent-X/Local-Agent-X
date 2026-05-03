import { describe, it, expect } from "vitest";
import { _internals } from "../src/memory/end-of-turn-write.js";

const { parseWriteDecision } = _internals;

describe("end-of-turn parseWriteDecision — happy path", () => {
  it("parses a clean append decision", () => {
    const raw = `{"write": true, "file": "user", "action": "append", "section_heading": null, "content": "Alex prefers business-suite-level dashboards over per-app for analytics."}`;
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.write).toBe(true);
    expect(r?.file).toBe("user");
    expect(r?.action).toBe("append");
    expect(r?.section_heading).toBeNull();
    expect(r?.content).toContain("dashboards");
  });

  it("parses a replace_section decision with heading", () => {
    const raw = `{"write": true, "file": "mind", "action": "replace_section", "section_heading": "Analytics workflow", "content": "For Instagram analytics, use Meta Business Suite + toggle dropdown to Instagram."}`;
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.action).toBe("replace_section");
    expect(r?.section_heading).toBe("Analytics workflow");
  });

  it("parses write=false correctly", () => {
    const raw = `{"write": false}`;
    const r = parseWriteDecision(raw);
    expect(r).toBeNull(); // null = no write to perform
  });

  it("strips ```json``` code fences", () => {
    const raw = "```json\n{\"write\": true, \"file\": \"user\", \"action\": \"append\", \"section_heading\": null, \"content\": \"x\"}\n```";
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.content).toBe("x");
  });

  it("tolerates leading prose before the JSON", () => {
    const raw = "Here's my decision:\n{\"write\": true, \"file\": \"mind\", \"action\": \"append\", \"section_heading\": null, \"content\": \"x\"}";
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
  });
});

describe("end-of-turn parseWriteDecision — defensive", () => {
  it("returns null on unparseable JSON", () => {
    expect(parseWriteDecision("not json")).toBeNull();
    expect(parseWriteDecision("{write: true}")).toBeNull();
    expect(parseWriteDecision("")).toBeNull();
  });

  it("returns null when file is invalid", () => {
    const r = parseWriteDecision(`{"write": true, "file": "bogus", "action": "append", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when action is invalid", () => {
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "bogus", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when content is missing", () => {
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "append", "section_heading": null}`);
    expect(r).toBeNull();
  });

  it("returns null when content is empty string", () => {
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "append", "section_heading": null, "content": ""}`);
    expect(r).toBeNull();
  });

  it("returns null when replace_section has no section_heading", () => {
    // Defensive: replace_section without a heading is meaningless
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "replace_section", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null on absurdly long content (sanity cap)", () => {
    const longContent = "x".repeat(900);
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "append", "section_heading": null, "content": "${longContent}"}`);
    expect(r).toBeNull();
  });

  it("treats whitespace-only content as missing", () => {
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "append", "section_heading": null, "content": "   "}`);
    expect(r).toBeNull();
  });

  it("treats whitespace-only section_heading as missing on replace_section", () => {
    const r = parseWriteDecision(`{"write": true, "file": "user", "action": "replace_section", "section_heading": "   ", "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when write field missing", () => {
    const r = parseWriteDecision(`{"file": "user", "action": "append", "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when write=true but write isn't strictly boolean true", () => {
    // Defensive: don't coerce truthy values; require explicit true
    const r = parseWriteDecision(`{"write": "yes", "file": "user", "action": "append", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });
});
