/**
 * readConfig tells the user's own git config from the repository's by the
 * scope git reports, so whatever the repository brings in through an include
 * must come back at the repository's scope, never the user's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUserScope, readConfig } from "./config-scope.js";

let root = "";
let repo = "";
let systemFile = "";
let globalFile = "";
const saved = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-config-scope-"));
  repo = join(root, "repo");
  git(root, "init", "-q", repo);
  systemFile = join(root, "system.cfg");
  globalFile = join(root, "global.cfg");
  writeFileSync(systemFile, "");
  writeFileSync(globalFile, "");
  process.env.GIT_CONFIG_SYSTEM = systemFile;
  process.env.GIT_CONFIG_GLOBAL = globalFile;
});

afterEach(() => {
  for (const [name, value] of [["GIT_CONFIG_SYSTEM", saved.system], ["GIT_CONFIG_GLOBAL", saved.global]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("reports each entry at the scope of the file that holds or includes it, in git's order", async () => {
    git(root, "config", "-f", systemFile, "credential.helper", "sys");
    git(root, "config", "-f", globalFile, "include.path", "global-inc.cfg");
    git(root, "config", "-f", join(root, "global-inc.cfg"), "credential.helper", "global-included");
    git(root, "config", "-f", globalFile, "credential.https://github.com.helper", "");
    git(repo, "config", "credential.helper", "repo");
    git(repo, "config", "include.path", "../../repo-inc.cfg");
    git(repo, "config", "includeIf.gitdir:**.path", "../../repo-inc.cfg");
    git(root, "config", "-f", join(root, "repo-inc.cfg"), "credential.helper", "repo-included");
    const read = await readConfig(repo, "^credential\\.");
    expect(read).toEqual({
      ok: true,
      entries: [
        { scope: "system", key: "credential.helper", value: "sys" },
        { scope: "global", key: "credential.helper", value: "global-included" },
        { scope: "global", key: "credential.https://github.com.helper", value: "" },
        { scope: "local", key: "credential.helper", value: "repo" },
        { scope: "local", key: "credential.helper", value: "repo-included" },
        { scope: "local", key: "credential.helper", value: "repo-included" },
      ],
    });
  });

  it("keeps a value with newlines whole and tells a key with no value from an empty one", async () => {
    appendFileSync(join(repo, ".git", "config"), '[http]\n\tsslVerify\n\textraHeader = "a\\nb"\n');
    expect(await readConfig(repo, "^http\\.")).toEqual({
      ok: true,
      entries: [
        { scope: "local", key: "http.sslverify", value: null },
        { scope: "local", key: "http.extraheader", value: "a\nb" },
      ],
    });
  });

  it("answers no entries when no key matches", async () => {
    expect(await readConfig(repo, "^credential\\.")).toEqual({ ok: true, entries: [] });
  });

  it("fails rather than answer with a list cut short", async () => {
    appendFileSync(join(repo, ".git", "config"), `[http]\n${"\tpostBuffer = 1\n".repeat(12_000)}\tsslVerify = false\n`);
    expect(await readConfig(repo, "^http\\.")).toEqual({ ok: false, reason: expect.stringMatching(/larger than the review reads/) });
  });

  it("fails with git's reason when git cannot read the config", async () => {
    appendFileSync(join(repo, ".git", "config"), "[broken\n");
    expect(await readConfig(repo, "^http\\.")).toEqual({ ok: false, reason: expect.stringMatching(/config/) });
  });

  it("counts only system and global as the user's", () => {
    expect(["system", "global"].every(isUserScope)).toBe(true);
    expect(["local", "worktree", "command", "unknown"].some(isUserScope)).toBe(false);
  });
});
