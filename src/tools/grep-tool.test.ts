import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePattern, ripgrepBin } from "./grep-tool.js";

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

describe("ripgrepBin — bundled-binary resolution", () => {
  const ORIG = process.env.LAX_BUNDLED_BIN_DIR;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  afterEach(() => {
    if (ORIG === undefined) delete process.env.LAX_BUNDLED_BIN_DIR;
    else process.env.LAX_BUNDLED_BIN_DIR = ORIG;
  });

  it("returns bare 'rg' when no bundle dir is set", () => {
    delete process.env.LAX_BUNDLED_BIN_DIR;
    expect(ripgrepBin()).toBe("rg");
  });

  it("returns the bundled absolute path when the binary exists there", () => {
    const dir = mkdtempSync(join(tmpdir(), "rgbin-"));
    const p = join(dir, exe);
    writeFileSync(p, "#!/bin/sh\n");
    process.env.LAX_BUNDLED_BIN_DIR = dir;
    expect(ripgrepBin()).toBe(p);
  });

  it("falls back to 'rg' when the bundle dir lacks the binary", () => {
    process.env.LAX_BUNDLED_BIN_DIR = mkdtempSync(join(tmpdir(), "rgempty-"));
    expect(ripgrepBin()).toBe("rg");
  });
});
