// check-doc-paths takes flags and doc paths on one command line; a flag is never
// read as a doc to check (`--verbose` alone used to fail with ENOENT).
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (...args: string[]) => execFileSync(process.execPath, ["scripts/check-doc-paths.mjs", ...args], { encoding: "utf8", stdio: "pipe" });

describe("check-doc-paths arguments", () => {
  it("checks the default docs when --verbose is the only argument", () => {
    expect(run("--verbose")).toMatch(/Doc paths OK \(\d+ docs checked\)/);
  });

  it("checks only the named doc when a flag comes with it", () => {
    expect(run("--verbose", "AGENTS.md")).toContain("Doc paths OK (1 docs checked)");
  });
});
