import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatGitStatus, workRootGitLine } from "./work-root-git.js";
// The repository is made through the same hardened git the line reads with:
// canonical-loop code may not import child_process (canonical-loop-11-boundary-audit).
import { runGit } from "../../publish-review/git-exec.js";

describe("formatGitStatus", () => {
  it("names the branch, its drift from upstream and the changed files", () => {
    expect(formatGitStatus("## main...origin/main [ahead 2]\n M src/a.ts\n?? notes.md\n"))
      .toBe("Git: on main (ahead 2), 2 changed: M src/a.ts, ?? notes.md");
  });

  it("says a clean tree is clean", () => {
    expect(formatGitStatus("## feature/x\n")).toBe("Git: on feature/x, no changes.");
  });

  it("lists six files and counts the rest", () => {
    const files = Array.from({ length: 9 }, (_, i) => ` M f${i}.ts`).join("\n");
    expect(formatGitStatus(`## main\n${files}\n`)).toMatch(/9 changed: .*f5\.ts \(\+3 more\)$/);
  });

  it("reads a repository with no commits yet", () => {
    expect(formatGitStatus("## No commits yet on main\n?? a.txt\n")).toBe("Git: on main, 1 changed: ?? a.txt");
  });
});

describe("workRootGitLine", () => {
  it("is null with no work root, and for a folder that is not a repository", async () => {
    expect(await workRootGitLine(undefined)).toBeNull();
    expect(await workRootGitLine(mkdtempSync(join(tmpdir(), "lax-git-none-")))).toBeNull();
  });

  it("reads a real repository through the hardened git", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-git-repo-"));
    expect((await runGit(root, ["init", "-q", "-b", "main"])).code).toBe(0);
    writeFileSync(join(root, "a.txt"), "x");
    expect(await workRootGitLine(root)).toBe("Git: on main, 1 changed: ?? a.txt");
  });
});
