/**
 * Tests for the self_edit exfil tripwire (exfil-scan.ts).
 *
 * We test the pure core — findSecretsInAddedContent — which scans
 * (file, added-text) pairs for secret-shaped material. The git extraction
 * (collectAddedContent / scanWorktreeForStagedSecrets) needs a live
 * worktree and is exercised end-to-end by the sandbox flow.
 */

import { describe, it, expect } from "vitest";
import { findSecretsInAddedContent } from "../src/self-edit/exfil-scan.js";

describe("findSecretsInAddedContent", () => {
  it("is clean when no added content carries a secret", () => {
    const result = findSecretsInAddedContent([
      { file: "src/foo.ts", text: "export const x = 1;\nfunction bar() { return x; }" },
      { file: "src/baz.ts", text: "// just a comment\nconst y = 'hello world';" },
    ]);
    expect(result.clean).toBe(true);
    expect(result.hits).toEqual([]);
  });

  it("flags a GitHub PAT staged into a source file", () => {
    const result = findSecretsInAddedContent([
      { file: "src/leak.ts", text: "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';" },
    ]);
    expect(result.clean).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].file).toBe("src/leak.ts");
    expect(result.hits[0].patterns.join(",")).toMatch(/GitHub/i);
  });

  it("flags an Anthropic API key staged into the diff", () => {
    const result = findSecretsInAddedContent([
      { file: "config/x.ts", text: "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA" },
    ]);
    expect(result.clean).toBe(false);
    expect(result.hits[0].file).toBe("config/x.ts");
  });

  it("reports distinct pattern names per file without duplicates", () => {
    const result = findSecretsInAddedContent([
      {
        file: "src/multi.ts",
        text:
          "const a = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n" +
          "const b = 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';",
      },
    ]);
    expect(result.clean).toBe(false);
    // Two GitHub PATs, one file → one hit, one distinct pattern name.
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].patterns).toHaveLength(1);
  });

  it("ignores empty added-text entries", () => {
    const result = findSecretsInAddedContent([
      { file: "src/empty.ts", text: "" },
    ]);
    expect(result.clean).toBe(true);
  });
});
