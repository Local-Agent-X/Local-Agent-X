/**
 * One shell command was enough to send the user's synced memory and chats
 * (and the sync token) to another repository: `git -C ~/.lax/sync-repo config
 * remote.origin.pushurl <elsewhere>`, or a url.*.insteadOf rule. init()'s
 * set-url reset origin's url but neither of those, and the next automatic sync
 * pushed. A sync now refuses before it copies or sends anything, and the other
 * repository receives nothing. Local bare repositories stand in for both ends
 * (a file-path remote needs no sign-in); the user's global config is the
 * test's own file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSync } from "../src/sync/index.js";

let root = "";
let dataDir = "";
let origin = "";
let elsewhere = "";
let globalConfig = "";
let sync: AgentSync;
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const syncRepo = (): string => join(dataDir, "sync-repo");
const commits = (bare: string): string => { try { return git(bare, "rev-list", "--all"); } catch { return ""; } };

function bareWithSeed(dir: string): void {
  git(root, "init", "-q", "--bare", "-b", "main", dir);
  const seed = mkdtempSync(join(root, "seed-"));
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "seed.txt"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", dir, "main");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lax-sync-redirect-"));
  globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  dataDir = join(root, ".lax");
  mkdirSync(dataDir);
  origin = join(root, "origin.git");
  elsewhere = join(root, "elsewhere.git");
  bareWithSeed(origin);
  git(root, "init", "-q", "--bare", "-b", "main", elsewhere);
  writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: origin, syncSessions: false, syncProtocols: false }));
  writeFileSync(join(dataDir, "MEMORY.md"), "the user's memory\n");
  sync = new AgentSync(dataDir, () => "test-token");
}, 30_000);

afterEach(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  rmSync(root, { recursive: true, force: true });
});

describe("a sync never sends the user's data anywhere but the configured repository", () => {
  it("pushes to the configured repository when nothing redirects it", async () => {
    const before = commits(origin);
    expect(await sync.push()).toMatchObject({ success: true });
    expect(commits(origin)).not.toBe(before);
  }, 60_000);

  it("refuses a push URL the agent set with one git config command", async () => {
    expect(await sync.init()).toBe(true);
    git(syncRepo(), "config", "remote.origin.pushurl", elsewhere);

    const r = await sync.push();

    expect(r.success).toBe(false);
    expect(r.message).toContain("remote.*.pushurl");
    expect(commits(elsewhere)).toBe("");
  }, 60_000);

  it("refuses a rewrite rule in the user's own config that sends the push elsewhere", async () => {
    expect(await sync.init()).toBe(true);
    git(root, "config", "-f", globalConfig, `url.${elsewhere}.pushInsteadOf`, origin);

    const r = await sync.push();

    expect(r.success).toBe(false);
    expect(r.message).toContain("git would push your sync data to");
    expect(commits(elsewhere)).toBe("");
  }, 60_000);

  it("refuses a pull from anywhere but the configured repository", async () => {
    expect(await sync.init()).toBe(true);
    git(root, "config", "-f", globalConfig, `url.${elsewhere}.insteadOf`, origin);

    const r = await sync.pull();

    expect(r.success).toBe(false);
    expect(r.message).toContain("git would fetch your sync data from");
  }, 60_000);
});
