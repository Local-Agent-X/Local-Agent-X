import { describe, it, expect } from "vitest";
import { formatUnknownToolCorrection, collectArgViolations } from "./enforce-policy.js";

// A weak / non-Anthropic model that hallucinates a tool name or mangles args
// must get a STRUCTURED corrective it can act on in one turn — the valid tool
// names for a bad name, the specific failing field for bad args — not a bare
// "Unknown tool" / "Invalid arguments" line.
describe("hallucinated tool name → corrective lists valid names", () => {
  it("names the exact available tools (so the model can self-correct)", () => {
    const msg = formatUnknownToolCorrection("search_files", ["read", "grep", "glob", "bash"]);
    expect(msg).toContain('"search_files"');           // the bad name, quoted
    for (const real of ["read", "grep", "glob", "bash"]) expect(msg).toContain(real);
    expect(msg).toContain("tool_search");              // escape hatch for missing capabilities
  });

  it("caps an oversized list but still points at tool_search", () => {
    const many = Array.from({ length: 70 }, (_, i) => `tool_${String(i).padStart(2, "0")}`);
    const msg = formatUnknownToolCorrection("nope", many);
    expect(msg).toContain("more)");                    // truncation marker
    expect(msg).toContain("tool_search");
  });
});

describe("malformed args → corrective names the failing field", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, count: { type: "number" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["path"],
  };

  it("flags a missing required field by name", () => {
    expect(collectArgViolations({ count: 1 }, schema)).toContain('missing required field "path"');
  });

  it("flags a wrong-typed field by name and expected type", () => {
    expect(collectArgViolations({ path: "x", count: "12" }, schema)).toContain('"count" must be a number (got string)');
  });

  it("flags an out-of-enum value by name", () => {
    const errs = collectArgViolations({ path: "x", mode: "z" }, schema);
    expect(errs.some((e) => e.startsWith('"mode" must be one of'))).toBe(true);
  });

  it("is empty for a well-formed call", () => {
    expect(collectArgViolations({ path: "x", count: 1, mode: "a" }, schema)).toEqual([]);
  });
});
