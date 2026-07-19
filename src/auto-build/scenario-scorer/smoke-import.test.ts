import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("scenario scorer import boundary", () => {
  it("does not load Playwright while the ordinary tool registry boots", () => {
    const source = [
      "const before = globalThis.fetch;",
      "await import('./src/tools/registry-build.ts');",
      "if (globalThis.fetch !== before) process.exit(41);",
      "process.exit(0);",
    ].join("\n");

    expect(() => execFileSync(
      process.execPath,
      ["--import=tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 },
    )).not.toThrow();
  });
});
