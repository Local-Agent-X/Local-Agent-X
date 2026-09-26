import { describe, it, expect } from "vitest";
import { formatUnknownToolCorrection, collectArgViolations } from "./enforce-policy.js";
import { findActionOwner } from "./arg-validation.js";
import type { ToolDefinition } from "../types.js";

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

// A model that calls an ACTION by name ("switch_tab") has hallucinated a tool
// that does not exist, but it is one edit away from the right call. The answer
// is the call shape, not a list of 40 names to re-choose from.
describe("an action called as a tool → corrective names the real call shape", () => {
  const def = (name: string, props: Record<string, unknown>): ToolDefinition =>
    ({ name, description: "", parameters: { properties: props }, execute: async () => ({ content: "" }) }) as unknown as ToolDefinition;

  const browser = def("browser", { action: { enum: ["navigate", "tabs", "switch_tab"] }, device: { enum: ["iphone"] } });
  const read = def("read", { path: { type: "string" } });

  it("finds the tool whose schema declares the name, and the argument it belongs to", () => {
    expect(findActionOwner("switch_tab", [read, browser])).toEqual({ tool: "browser", param: "action" });
  });

  it("reads what the tool declares, so it is not keyed to any one action or argument", () => {
    expect(findActionOwner("iphone", [browser])).toEqual({ tool: "browser", param: "device" });
    expect(findActionOwner("navigate", [browser])).toEqual({ tool: "browser", param: "action" });
  });

  it("stays silent for a name no available tool declares", () => {
    expect(findActionOwner("switch_tab", [read])).toBeNull();
    expect(findActionOwner("totally_made_up", [read, browser])).toBeNull();
  });

  // The name list is the op's own tier-capped surface on purpose. A hint built
  // from the global tools table would disclose a capability withheld from this op.
  it("is scoped to the op's surface, so a withheld tool is never disclosed", () => {
    expect(findActionOwner("switch_tab", [read])).toBeNull();
  });

  it("leads the corrective with the call shape and still lists the valid names", () => {
    const msg = formatUnknownToolCorrection("switch_tab", ["read", "browser"], { tool: "browser", param: "action" });
    expect(msg).toContain('call browser with action="switch_tab"');
    expect(msg.indexOf("call browser")).toBeLessThan(msg.indexOf("Use one of these exact names"));
    expect(msg).toContain("tool_search");
  });

  it("is unchanged when there is no owner", () => {
    expect(formatUnknownToolCorrection("nope", ["read"])).not.toContain("is a value of");
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
