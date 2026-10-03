/**
 * Tests for the self_edit exfil tripwire (exfil-scan.ts).
 *
 * We test the pure core — findSecretsInAddedContent — which scans
 * (file, added-text) pairs for secret-shaped material, and the git extraction
 * (scanWorktreeForStagedSecrets) against a real repository whose config is
 * hostile. The rest of the extraction is exercised end-to-end by the sandbox
 * flow.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecretsInAddedContent, scanWorktreeForStagedSecrets } from "../src/self-edit/exfil-scan.js";

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

// The scan runs on the host against a worktree whose .git config and
// .gitattributes the child wrote. Each of these would run a command of the
// child's choosing, and the diff driver and textconv filter would also hand
// the scan text without the secret in it.
describe("scanWorktreeForStagedSecrets against a hostile worktree config", () => {
  const HOOKS = ["fsmonitor", "ext-diff", "textconv"];

  it("starts no fsmonitor hook, external diff or textconv filter, and still sees the secret", () => {
    const repo = mkdtempSync(join(tmpdir(), "lax-exfil-hostile-"));
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
    const marker = (name: string) => join(repo, `fired-${name}`).replace(/\\/g, "/");
    try {
      g("init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      g("add", "-A");
      g("commit", "-q", "-m", "base");
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
      writeFileSync(join(repo, "b.ts"), `export const t = "ghp_${"a".repeat(36)}";\n`);
      g("add", "-A");
      g("commit", "-q", "-m", "committed secret");
      writeFileSync(join(repo, "a.ts"), `export const u = "ghp_${"b".repeat(36)}";\n`);
      g("config", "core.fsmonitor", `touch '${marker("fsmonitor")}'; false`);
      g("config", "diff.external", `touch '${marker("ext-diff")}'; true`);
      g("config", "diff.hide.textconv", `touch '${marker("textconv")}'; echo clean`);
      writeFileSync(join(repo, ".git", "info", "attributes"), "*.ts diff=hide\n");

      const result = scanWorktreeForStagedSecrets(repo, baseSha);

      expect(HOOKS.filter((h) => existsSync(marker(h)))).toEqual([]);
      expect(result.hits.map((h) => h.file).sort()).toEqual(["a.ts", "b.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
