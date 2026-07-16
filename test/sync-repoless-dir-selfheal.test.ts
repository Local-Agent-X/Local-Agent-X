/**
 * Regression — init() guarded on the sync-repo DIRECTORY existing, not on it
 * being a repository. Live failure (2026-07-14): a clone failed, its silent
 * `git init` fallback failed too, and the mkdir'd directory survived. Every
 * later init saw the directory, skipped the clone, swallowed the failing
 * `remote set-url`, and returned true for a path with no .git — so push()
 * filled it with the user's brain via copyToSync while every git command
 * failed, and pull() answered "Could not reach remote" forever, naming the
 * network for what was a local repair problem.
 *
 * init() must treat a repo-less directory as repairable state, adopt the
 * remote history in place (clone refuses a populated dir), and never destroy
 * the local files sitting in it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const newSync = () => new AgentSync(dataDir, () => "test-token");

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sync-repoless-"));
  originDir = join(dataDir, "origin.git");
  syncRepo = join(dataDir, "sync-repo");
  mkdirSync(originDir, { recursive: true });
  await git(originDir, "init", "--bare", "-b", "main");

  const seedDir = join(dataDir, "seed");
  mkdirSync(seedDir, { recursive: true });
  await git(seedDir, "init", "-b", "main");
  writeFileSync(join(seedDir, "from-remote.txt"), "remote state\n");
  await git(seedDir, "add", "-A");
  await git(seedDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed");
  await git(seedDir, "remote", "add", "origin", originDir);
  await git(seedDir, "push", "origin", "main");

  writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: originDir }));
}, 30_000);

afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("sync init repairs a repo-less sync-repo directory", () => {
  it("quarantines a populated repo-less dir and re-clones from origin", async () => {
    // The wedged state: populated by copyToSync, but never a repository.
    mkdirSync(syncRepo, { recursive: true });
    writeFileSync(join(syncRepo, "facts.jsonl"), "local brain\n");

    expect(await newSync().init()).toBe(true);

    // A real clone with the remote's history — origin/main is reachable, so
    // pull()'s fetch (the call that reported "Could not reach remote") works.
    expect(existsSync(join(syncRepo, ".git"))).toBe(true);
    await expect(git(syncRepo, "fetch", "origin", "main")).resolves.toBeDefined();
    expect(existsSync(join(syncRepo, "from-remote.txt"))).toBe(true);
    expect((await git(syncRepo, "rev-parse", "HEAD")).stdout.trim())
      .toBe((await git(originDir, "rev-parse", "main")).stdout.trim());

    // The mirror is rebuilt from dataDir by copyToSync, so the old bytes are
    // quarantined for inspection, never adopted as commits — adopting them
    // would stage every remote-only file as a deletion.
    expect(readFileSync(join(`${syncRepo}.broken`, "facts.jsonl"), "utf8")).toBe("local brain\n");
    expect((await git(syncRepo, "status", "--porcelain")).stdout.trim()).toBe("");
  }, 30_000);

  it("still clones normally into an empty or absent directory", async () => {
    expect(await newSync().init()).toBe(true);
    expect(existsSync(join(syncRepo, ".git"))).toBe(true);
    // A real clone, not a bare init: the remote's content is on disk.
    expect(existsSync(join(syncRepo, "from-remote.txt"))).toBe(true);
  }, 30_000);

  it("repairs against a brand-new empty remote — cloning it is not a failure", async () => {
    const emptyOrigin = join(dataDir, "empty.git");
    mkdirSync(emptyOrigin, { recursive: true });
    await git(emptyOrigin, "init", "--bare", "-b", "main");
    writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: emptyOrigin }));
    mkdirSync(syncRepo, { recursive: true });
    writeFileSync(join(syncRepo, "facts.jsonl"), "local brain\n");

    // Cloning a repo with no commits yet succeeds; the first push seeds main.
    expect(await newSync().init()).toBe(true);
    expect(existsSync(join(syncRepo, ".git"))).toBe(true);
    expect(readFileSync(join(`${syncRepo}.broken`, "facts.jsonl"), "utf8")).toBe("local brain\n");
  }, 30_000);

  it("does not leave a broken repo behind when the remote is unreachable", async () => {
    writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: join(dataDir, "does-not-exist.git") }));
    mkdirSync(syncRepo, { recursive: true });
    writeFileSync(join(syncRepo, "facts.jsonl"), "local brain\n");

    // Must surface, not silently return true for an unusable repo — that
    // silence is what wedged sync in the first place.
    await expect(newSync().init()).rejects.toThrow();
  }, 30_000);
});
