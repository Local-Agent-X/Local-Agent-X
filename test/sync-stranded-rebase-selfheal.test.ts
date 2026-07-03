/**
 * SV-8 regression — a git child killed mid-rebase (heartbeat pull/push dying,
 * compounded by a hard exit) strands .git/index.lock and rebase-merge/ in the
 * sync repo. Before the fix nothing ever cleaned them: the next pull --rebase
 * failed on the lock, push()'s rebase --abort failed on the SAME lock, the
 * --no-rebase fallback failed too, and every future sync was wedged until the
 * user hand-deleted the lock. init() must detect + heal that stranded state —
 * but must NOT touch a fresh lock that may belong to a live git process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentSync } from "../src/sync/index.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let dataDir: string;
let originDir: string;
let syncRepo: string;
let sync: AgentSync;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sync-selfheal-"));
  // Local bare origin with one commit on main — file-path remotes need no auth.
  originDir = join(dataDir, "origin.git");
  const seedDir = join(dataDir, "seed");
  mkdirSync(originDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  await git(originDir, "init", "--bare", "-b", "main");
  await git(seedDir, "init", "-b", "main");
  writeFileSync(join(seedDir, "seed.txt"), "hello\n");
  await git(seedDir, "add", "-A");
  await git(seedDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed");
  await git(seedDir, "remote", "add", "origin", originDir);
  await git(seedDir, "push", "origin", "main");

  writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: originDir }));
  sync = new AgentSync(dataDir, () => "test-token");
  expect(await sync.init()).toBe(true); // clones into dataDir/sync-repo
  syncRepo = join(dataDir, "sync-repo");
  expect(existsSync(join(syncRepo, ".git"))).toBe(true);
}, 30_000);

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("sync init self-heals stranded git state (SV-8)", () => {
  it("removes a stale index.lock and stranded rebase-merge/ so git is operable again", async () => {
    // Simulate a git child killed mid-rebase: leftover lock + partial rebase dir.
    const lock = join(syncRepo, ".git", "index.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old); // crash happened minutes ago
    const rebaseDir = join(syncRepo, ".git", "rebase-merge");
    mkdirSync(rebaseDir, { recursive: true });
    writeFileSync(join(rebaseDir, "head-name"), "refs/heads/main\n");

    expect(await sync.init()).toBe(true);

    expect(existsSync(lock)).toBe(false);
    expect(existsSync(rebaseDir)).toBe(false);
    // The repo is operable again: index-locking ops no longer fail.
    writeFileSync(join(syncRepo, "new.txt"), "after heal\n");
    await expect(git(syncRepo, "add", "-A")).resolves.toBeDefined();
  }, 30_000);

  it("leaves a fresh index.lock alone — it may belong to a live git process", async () => {
    const lock = join(syncRepo, ".git", "index.lock");
    writeFileSync(lock, ""); // mtime = now

    expect(await sync.init()).toBe(true);

    expect(existsSync(lock)).toBe(true);
  }, 30_000);
});
