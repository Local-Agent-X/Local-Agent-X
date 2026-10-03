/**
 * runGit runs before approval with the agent's repository as its cwd, so the
 * git it starts must be the PATH's git, never a program the agent left in that
 * repository under git's name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitErrorLine, runGit } from "./git-exec.js";

let repo = "";
let emptyDir = "";
const savedNoCwdLookup = process.env.NoDefaultCurrentDirectoryInExePath;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-exec-planted-"));
  emptyDir = mkdtempSync(join(tmpdir(), "git-exec-nopath-"));
  // A renamed node.exe: started as git, it is not git and never prints git's banner.
  if (process.platform === "win32") copyFileSync(process.execPath, join(repo, "git.exe"));
  // The server switches the Windows cwd-first lookup off at boot; runGit must
  // not depend on that, so this file runs with the lookup on.
  delete process.env.NoDefaultCurrentDirectoryInExePath;
});

afterAll(() => {
  if (savedNoCwdLookup !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwdLookup;
  rmSync(repo, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("runGit", () => {
  it("starts the PATH's git, not a git.exe planted in the cwd", async () => {
    const r = await runGit(repo, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version \d/);
  });

  it("adds a caller's variables to git's environment, and none of them undoes the hardening", async () => {
    // The user's own helpers are cleared, so the only one asked is this, which
    // answers with what its environment holds.
    const helper = '!f() { echo "username=$LAX_ADDED"; echo "password=$GIT_TERMINAL_PROMPT"; }; f';
    const r = await runGit(repo, ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "credential", "fill"], {
      input: "protocol=https\nhost=example.com\n\n",
      env: { LAX_ADDED: "added", GIT_TERMINAL_PROMPT: "1" },
    });
    expect(r.stdout).toContain("username=added\n");
    expect(r.stdout).toContain("password=0\n");
  });

  it("reports git as missing, without starting anything, when the PATH has none", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const r = await runGit(repo, ["--version"]);
      expect(r.missing).toBe(true);
      expect(r.stdout).toBe("");
      expect(gitErrorLine(r)).toBe("git is not installed or not on PATH");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
