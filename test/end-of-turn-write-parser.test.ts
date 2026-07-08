import { describe, it, expect } from "vitest";
import { _internals } from "../src/memory/end-of-turn-write.js";

const { parseWriteDecision } = _internals;

describe("end-of-turn parseWriteDecision — happy path", () => {
  it("parses a clean append decision (no file field — USER.md implied)", () => {
    const raw = `{"write": true, "action": "append", "section_heading": null, "content": "Alex prefers business-suite-level dashboards over per-app for analytics."}`;
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.write).toBe(true);
    expect(r?.action).toBe("append");
    expect(r?.section_heading).toBeNull();
    expect(r?.content).toContain("dashboards");
  });

  it("parses a legacy decision with file=user", () => {
    const raw = `{"write": true, "file": "user", "action": "append", "section_heading": null, "content": "x"}`;
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.action).toBe("append");
  });

  it("parses a replace_section decision with heading", () => {
    const raw = `{"write": true, "action": "replace_section", "section_heading": "Analytics workflow", "content": "For Instagram analytics, use Meta Business Suite + toggle dropdown to Instagram."}`;
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.action).toBe("replace_section");
    expect(r?.section_heading).toBe("Analytics workflow");
  });

  it("rejects legacy file=mind decisions (mind is retired)", () => {
    const raw = `{"write": true, "file": "mind", "action": "append", "section_heading": null, "content": "x"}`;
    const r = parseWriteDecision(raw);
    expect(r).toBeNull();
  });

  it("parses write=false as a valid no-write decision — NOT a parse failure", () => {
    const raw = `{"write": false}`;
    const r = parseWriteDecision(raw);
    expect(r).toEqual({ write: false });
  });

  it("strips ```json``` code fences", () => {
    const raw = "```json\n{\"write\": true, \"action\": \"append\", \"section_heading\": null, \"content\": \"x\"}\n```";
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
    expect(r?.write && r.content).toBe("x");
  });

  it("tolerates leading prose before the JSON", () => {
    const raw = "Here's my decision:\n{\"write\": true, \"action\": \"append\", \"section_heading\": null, \"content\": \"x\"}";
    const r = parseWriteDecision(raw);
    expect(r).not.toBeNull();
  });
});

describe("end-of-turn parseWriteDecision — fenced model output (live opus shapes)", () => {
  // The realistic payload shape the classifier prompt asks for.
  const decision = {
    write: true,
    action: "append",
    section_heading: null,
    content: "User prefers Meta Business Suite over per-app dashboards for analytics across Meta properties.",
  };

  it("parses the exact live failure shape: ```json-fenced {\"write\": false} is a decision, not garbage", () => {
    // claude-opus-4-8 fences the JSON despite the prompt; write=false is its
    // most common verdict. This used to return null → logged as
    // `parse failed: "```json…` and conflated with real parse failures.
    const raw = '```json\n{"write": false}\n```';
    expect(parseWriteDecision(raw)).toEqual({ write: false });
  });

  it("parses a ```json-fenced pretty-printed write decision", () => {
    const raw = "```json\n" + JSON.stringify(decision, null, 2) + "\n```";
    const r = parseWriteDecision(raw);
    expect(r).toEqual(decision);
  });

  it("parses a fenced decision with no language tag", () => {
    const raw = "```\n" + JSON.stringify(decision) + "\n```";
    expect(parseWriteDecision(raw)).toEqual(decision);
  });

  it("parses a single fenced block surrounded by prose", () => {
    const raw =
      "Looking at the exchange, this reveals a durable preference.\n\n" +
      "```json\n" + JSON.stringify(decision) + "\n```\n\n" +
      "That captures the generalized rule.";
    expect(parseWriteDecision(raw)).toEqual(decision);
  });

  it("parses a fenced replace_section decision with heading", () => {
    const rs = {
      write: true,
      action: "replace_section",
      section_heading: "Analytics workflow",
      content: "For Instagram analytics use Meta Business Suite and toggle the asset dropdown to Instagram.",
    };
    const raw = "```json\n" + JSON.stringify(rs, null, 2) + "\n```";
    expect(parseWriteDecision(raw)).toEqual(rs);
  });

  it("preserves backticks inside content when the reply is fenced", () => {
    // The old global ``` strip deleted backtick runs INSIDE the payload too.
    const bt = { ...decision, content: "Verifies with `npm run build`, never bare `tsc`." };
    const raw = "```json\n" + JSON.stringify(bt) + "\n```";
    const r = parseWriteDecision(raw);
    expect(r?.write && r.content).toBe("Verifies with `npm run build`, never bare `tsc`.");
  });

  it("recovers a decision from an unterminated fence (reply truncated after the JSON)", () => {
    const raw = "```json\n" + JSON.stringify(decision);
    expect(parseWriteDecision(raw)).toEqual(decision);
  });

  it("still rejects a fenced block that isn't a decision", () => {
    expect(parseWriteDecision("```json\nnot json at all\n```")).toBeNull();
    expect(parseWriteDecision("```\n[1, 2, 3]\n```")).toBeNull();
  });
});

describe("end-of-turn parseWriteDecision — defensive", () => {
  it("returns null on unparseable JSON", () => {
    expect(parseWriteDecision("not json")).toBeNull();
    expect(parseWriteDecision("{write: true}")).toBeNull();
    expect(parseWriteDecision("")).toBeNull();
  });

  it("returns null when file is anything other than 'user' (or absent)", () => {
    const r = parseWriteDecision(`{"write": true, "file": "bogus", "action": "append", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when action is invalid", () => {
    const r = parseWriteDecision(`{"write": true, "action": "bogus", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when content is missing", () => {
    const r = parseWriteDecision(`{"write": true, "action": "append", "section_heading": null}`);
    expect(r).toBeNull();
  });

  it("returns null when content is empty string", () => {
    const r = parseWriteDecision(`{"write": true, "action": "append", "section_heading": null, "content": ""}`);
    expect(r).toBeNull();
  });

  it("returns null when replace_section has no section_heading", () => {
    // Defensive: replace_section without a heading is meaningless
    const r = parseWriteDecision(`{"write": true, "action": "replace_section", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null on absurdly long content (sanity cap)", () => {
    const longContent = "x".repeat(900);
    const r = parseWriteDecision(`{"write": true, "action": "append", "section_heading": null, "content": "${longContent}"}`);
    expect(r).toBeNull();
  });

  it("treats whitespace-only content as missing", () => {
    const r = parseWriteDecision(`{"write": true, "action": "append", "section_heading": null, "content": "   "}`);
    expect(r).toBeNull();
  });

  it("treats whitespace-only section_heading as missing on replace_section", () => {
    const r = parseWriteDecision(`{"write": true, "action": "replace_section", "section_heading": "   ", "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when write field missing", () => {
    const r = parseWriteDecision(`{"action": "append", "content": "x"}`);
    expect(r).toBeNull();
  });

  it("returns null when write=true but write isn't strictly boolean true", () => {
    // Defensive: don't coerce truthy values; require explicit true
    const r = parseWriteDecision(`{"write": "yes", "action": "append", "section_heading": null, "content": "x"}`);
    expect(r).toBeNull();
  });
});
