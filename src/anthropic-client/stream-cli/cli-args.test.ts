import { describe, it, expect } from "vitest";
import { buildCliArgs } from "./cli-args.js";

function disallowedOf(args: string[]): string[] {
  const i = args.indexOf("--disallowed-tools");
  return i >= 0 ? args[i + 1].split(",") : [];
}

describe("buildCliArgs — native search gating", () => {
  it("tool mode: allows native WebSearch and forces it by disallowing the MCP search tool", () => {
    const disallowed = disallowedOf(buildCliArgs({ model: "m", textOnlyMode: false }));
    expect(disallowed).not.toContain("WebSearch");
    expect(disallowed).toContain("mcp__lax__web_search");
    // Fetch stays on LAX's gated path: native WebFetch blocked, MCP fetch left alone.
    expect(disallowed).toContain("WebFetch");
    expect(disallowed).not.toContain("mcp__lax__web_fetch");
  });

  it("text/plan mode: native set stays fully off, no MCP search override", () => {
    const disallowed = disallowedOf(buildCliArgs({ model: "m", textOnlyMode: true }));
    expect(disallowed).toContain("WebSearch");
    expect(disallowed).not.toContain("mcp__lax__web_search");
  });
});
