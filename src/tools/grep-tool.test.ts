import { describe, it, expect } from "vitest";
import { parsePattern } from "./grep-tool.js";

// The Node fallback used `new RegExp(pattern)` directly, which throws "Invalid
// group" on ripgrep/PCRE inline flags like `(?i)` — so a case-insensitive
// search that works under rg died whenever rg was absent. parsePattern lifts a
// leading inline-flag group into real RegExp flags so the two paths agree.
describe("grep parsePattern — inline-flag tolerance", () => {
  it("lifts a leading (?i) into the i flag", () => {
    expect(parsePattern("(?i)tailnet", false)).toEqual({ source: "tailnet", flags: "i" });
  });

  it("lifts combined leading flags (?is)", () => {
    const { source, flags } = parsePattern("(?is)foo.bar", false);
    expect(source).toBe("foo.bar");
    expect(flags.split("").sort().join("")).toBe("is");
  });

  it("merges (?i) with the case_insensitive option without duplicating", () => {
    expect(parsePattern("(?i)x", true)).toEqual({ source: "x", flags: "i" });
  });

  it("adds i from the case_insensitive option alone", () => {
    expect(parsePattern("plain", true)).toEqual({ source: "plain", flags: "i" });
  });

  it("leaves a flag-less pattern untouched", () => {
    expect(parsePattern("tailnet|tailscale", false)).toEqual({ source: "tailnet|tailscale", flags: "" });
  });

  it("only strips a LEADING group — a mid-pattern (?i) is left for the graceful-error path", () => {
    expect(parsePattern("foo(?i)bar", false)).toEqual({ source: "foo(?i)bar", flags: "" });
  });

  it("produces a regex that actually matches — the exact pattern that crashed the LAX run", () => {
    const { source, flags } = parsePattern("(?i)tailscale|tailnet", false);
    const re = new RegExp(source, flags); // before the fix, `new RegExp("(?i)...")` threw here
    expect(re.test("make sure both devices are on the same Tailscale network")).toBe(true);
    expect(re.test("the old TAILNET path")).toBe(true);
    expect(re.test("broker only")).toBe(false);
  });
});
