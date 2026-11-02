// The sync repository is trusted with the user's data and the vault's token
// only while its own config holds what clone and sync write, and origin
// fetches from and pushes to the configured repository after every rewrite
// rule. These run real git in a scratch repository; nothing contacts a remote
// (get-url and config only read). The user's global config is each test's own
// file (GIT_CONFIG_GLOBAL).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryKey, syncRepoRefusal } from "./sync-repo-trust.js";

const REPO = "https://github.com/acme/brain.git";
let root = "";
let repo = "";
let globalConfig = "";
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

const git = (cwd: string, ...args: string[]): void => { execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); };
const local = (key: string, value: string): void => git(repo, "config", "--add", key, value);
const user = (key: string, value: string): void => git(root, "config", "-f", globalConfig, "--add", key, value);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-sync-trust-"));
  repo = join(root, "sync-repo");
  globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "remote", "add", "origin", REPO);
  local("branch.main.remote", "origin");
  local("branch.main.merge", "refs/heads/main");
});

afterEach(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  rmSync(root, { recursive: true, force: true });
});

describe("syncRepoRefusal", () => {
  it("lets a freshly cloned sync repository through", async () => {
    expect(await syncRepoRefusal(repo, REPO)).toBeNull();
  });

  it("refuses a push URL in the repository's config, the agent's one-command redirect", async () => {
    local("remote.origin.pushurl", "https://evil.example/loot.git");
    const refused = await syncRepoRefusal(repo, REPO);
    expect(refused).toContain("remote.*.pushurl");
    expect(refused).not.toContain("evil.example");
  });

  it("refuses a rewrite rule in the repository's config, without echoing the URL it names", async () => {
    local("url.https://tok3n@evil.example/.insteadOf", "https://github.com/");
    const refused = await syncRepoRefusal(repo, REPO);
    expect(refused).toContain("url.*.insteadof");
    expect(refused).not.toContain("tok3n");
  });

  it.each([
    ["a filter that runs on add", "filter.x.clean", "sh -c true"],
    ["a merge driver that runs on pull", "merge.x.driver", "sh -c true"],
    ["a credential setting", "credential.helper", "store"],
    ["an include of another file", "include.path", "/tmp/elsewhere"],
    ["a second remote", "remote.mirror.url", "https://evil.example/x.git"],
  ])("refuses anything else sync never writes: %s", async (_name, key, value) => {
    local(key, value);
    expect(await syncRepoRefusal(repo, REPO)).toMatch(/sync never writes/);
  });

  it("refuses the user's own rewrite rule when it sends origin to another repository", async () => {
    user("url.https://evil.example/.insteadOf", "https://github.com/");
    const refused = await syncRepoRefusal(repo, REPO);
    expect(refused).toContain("git would fetch your sync data from https://evil.example/acme/brain.git");
  });

  it("refuses a pushInsteadOf that redirects only the push", async () => {
    user("url.https://evil.example/.pushInsteadOf", "https://github.com/");
    expect(await syncRepoRefusal(repo, REPO)).toContain("git would push your sync data to https://evil.example/acme/brain.git");
  });

  it("lets the user's own https-to-ssh rule for the same repository through", async () => {
    user("url.git@github.com:.insteadOf", "https://github.com/");
    expect(await syncRepoRefusal(repo, REPO)).toBeNull();
  });

  it("refuses an origin with more than one URL", async () => {
    local("remote.origin.url", "https://evil.example/second.git");
    expect(await syncRepoRefusal(repo, REPO)).toContain("https://github.com/acme/brain.git, https://evil.example/second.git");
  });
});

describe("repositoryKey", () => {
  it("is the same repository over https, ssh and scp-like addresses", () => {
    const key = "github.com/acme/brain";
    expect(repositoryKey("https://github.com/acme/brain.git")).toBe(key);
    expect(repositoryKey("https://x-access-token@GitHub.com/Acme/brain/")).toBe(key);
    expect(repositoryKey("ssh://git@github.com:22/acme/brain.git")).toBe(key);
    expect(repositoryKey("git@github.com:acme/brain.git")).toBe(key);
  });

  it("tells repositories and hosts apart, and has no key for a local path", () => {
    expect(repositoryKey("https://github.com/evil/brain.git")).not.toBe(repositoryKey(REPO));
    expect(repositoryKey("https://github.com.evil.example/acme/brain.git")).not.toBe(repositoryKey(REPO));
    expect(repositoryKey("C:\\Users\\me\\origin.git")).toBeNull();
    expect(repositoryKey("/srv/git/origin.git")).toBeNull();
  });
});
