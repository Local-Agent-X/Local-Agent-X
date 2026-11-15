// execGit: git off the event loop, with the same safety flags. The update check
// ran `git fetch` synchronously, so every request waited on the network.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeGitArgs, execGit } from "./git-safety.js";

describe("execGit", () => {
  it("returns git's output without holding the event loop", async () => {
    let ticked = false;
    setImmediate(() => { ticked = true; });
    const out = await execGit(composeGitArgs("--version"), { cwd: process.cwd() });
    expect(out).toMatch(/^git version /);
    expect(ticked).toBe(true);
  });

  it("rejects with git's stderr on a non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-execgit-"));
    try {
      const err = await execGit(composeGitArgs("rev-parse HEAD"), { cwd: dir }).catch((e: Error & { stderr?: string }) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { stderr?: string }).stderr).toMatch(/not a git repository/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
