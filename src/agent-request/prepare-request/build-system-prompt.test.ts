import { describe, it, expect } from "vitest";
import { fileAccessGroundingBlock } from "./build-system-prompt.js";

describe("fileAccessGroundingBlock", () => {
  it("unrestricted tells the model it can read ANY file", () => {
    const block = fileAccessGroundingBlock("unrestricted");
    expect(block).toContain("[FILE ACCESS: UNRESTRICTED]");
    expect(block).toContain("ANY file");
    // The whole point: no grounds for refusal beyond missing / credential files.
    expect(block).toMatch(/does not exist or is a blocked credential/i);
  });

  it("common names the allowed roots and points at Settings, not 'unable'", () => {
    const block = fileAccessGroundingBlock("common");
    expect(block).toContain("[FILE ACCESS: COMMON]");
    expect(block).toMatch(/Documents/);
    expect(block).toMatch(/Settings/);
    expect(block).toMatch(/don't claim you are simply unable/i);
  });

  it("workspace says reads are blocked BY POLICY (not a missing tool) and mentions Settings", () => {
    const block = fileAccessGroundingBlock("workspace");
    expect(block).toContain("[FILE ACCESS: WORKSPACE-ONLY]");
    expect(block).toMatch(/BY POLICY/);
    expect(block).toMatch(/not by a missing tool/i);
    expect(block).toMatch(/Settings/);
  });

  it("every mode produces a non-empty, prefixed block", () => {
    for (const mode of ["unrestricted", "common", "workspace"] as const) {
      const block = fileAccessGroundingBlock(mode);
      expect(block.startsWith("\n\n[FILE ACCESS:")).toBe(true);
      expect(block.length).toBeGreaterThan(40);
    }
  });
});
