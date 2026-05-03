import { describe, it, expect } from "vitest";
import { _internals } from "../src/memory/curate-classifier.js";

const { parseClassifierResponse } = _internals;

describe("curate-classifier — parser tolerance", () => {
  it("parses a clean JSON response", () => {
    const raw = `{"teach": true, "kind": "correction", "confidence": 0.85, "why": "user redirected the action"}`;
    const r = parseClassifierResponse(raw);
    expect(r).not.toBeNull();
    expect(r?.teach).toBe(true);
    expect(r?.kind).toBe("correction-detected");
    expect(r?.confidence).toBe(0.85);
    expect(r?.why).toContain("redirected");
  });

  it("strips ```json code fences if the model adds them", () => {
    const raw = "```json\n{\"teach\": true, \"kind\": \"preference\", \"confidence\": 0.9, \"why\": \"stated a workflow\"}\n```";
    const r = parseClassifierResponse(raw);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("preference-stated");
  });

  it("strips bare ``` fences too", () => {
    const raw = "```\n{\"teach\": false, \"kind\": \"none\", \"confidence\": 0.2, \"why\": \"routine ack\"}\n```";
    const r = parseClassifierResponse(raw);
    expect(r).not.toBeNull();
    expect(r?.teach).toBe(false);
    expect(r?.kind).toBe("none");
  });

  it("tolerates leading prose before the JSON", () => {
    const raw = "Here's the classification:\n{\"teach\": true, \"kind\": \"workflow\", \"confidence\": 0.7, \"why\": \"multi-step rule\"}";
    const r = parseClassifierResponse(raw);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("preference-stated"); // workflow → preference-stated trigger
  });

  it("tolerates trailing prose after the JSON", () => {
    const raw = "{\"teach\": true, \"kind\": \"fact\", \"confidence\": 0.8, \"why\": \"user address\"}\n\nLet me know if you need a different format.";
    const r = parseClassifierResponse(raw);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("preference-stated"); // fact → preference-stated trigger
  });

  it("clamps confidence to [0,1]", () => {
    const r1 = parseClassifierResponse(`{"teach": true, "kind": "correction", "confidence": 1.5, "why": "x"}`);
    expect(r1?.confidence).toBe(1);
    const r2 = parseClassifierResponse(`{"teach": true, "kind": "correction", "confidence": -0.3, "why": "x"}`);
    expect(r2?.confidence).toBe(0);
  });

  it("returns null on invalid JSON", () => {
    expect(parseClassifierResponse("not json")).toBeNull();
    expect(parseClassifierResponse("{teach: true}")).toBeNull(); // unquoted key
    expect(parseClassifierResponse("{\"teach\": true,")).toBeNull(); // truncated
  });

  it("returns null on empty input", () => {
    expect(parseClassifierResponse("")).toBeNull();
  });

  it("returns null when kind is invalid", () => {
    const r = parseClassifierResponse(`{"teach": true, "kind": "bogus", "confidence": 0.9, "why": "x"}`);
    expect(r).toBeNull();
  });

  it("treats missing confidence as 0", () => {
    const r = parseClassifierResponse(`{"teach": true, "kind": "preference", "why": "no conf field"}`);
    expect(r?.confidence).toBe(0);
  });

  it("kind=none always maps to kind=none regardless of teach flag", () => {
    const r = parseClassifierResponse(`{"teach": false, "kind": "none", "confidence": 0.1, "why": "routine"}`);
    expect(r?.teach).toBe(false);
    expect(r?.kind).toBe("none");
  });

  it("kind=explicit-remember stays as explicit-remember trigger", () => {
    const r = parseClassifierResponse(`{"teach": true, "kind": "explicit-remember", "confidence": 0.95, "why": "user said remember"}`);
    expect(r?.kind).toBe("explicit-remember");
  });

  it("teach=false maps kind to none even if classifier emitted a category", () => {
    // Defensive: if classifier said teach=false but emitted kind=correction
    // (shouldn't happen per prompt, but be safe), don't trigger a boost
    const r = parseClassifierResponse(`{"teach": false, "kind": "correction", "confidence": 0.3, "why": "x"}`);
    expect(r?.teach).toBe(false);
    expect(r?.kind).toBe("none");
  });

  it("truncates 'why' field to prevent log bloat", () => {
    const longWhy = "x".repeat(500);
    const r = parseClassifierResponse(`{"teach": true, "kind": "preference", "confidence": 0.8, "why": "${longWhy}"}`);
    expect(r?.why.length).toBeLessThanOrEqual(120);
  });

  it("preserves the raw response (truncated) for debugging", () => {
    const raw = `{"teach": true, "kind": "fact", "confidence": 0.7, "why": "address"}`;
    const r = parseClassifierResponse(raw);
    expect(r?.raw).toBeTruthy();
    expect(r?.raw.length).toBeLessThanOrEqual(500);
  });
});
