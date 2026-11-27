/**
 * Two machines sync to one repo and both change the same files. The other
 * machine's sync failed every time (2026-11-27): the rebase conflicted, and
 * the merge fallback's conflict resolver sat after a `git pull` that throws on
 * the conflict, so it never ran and the repo was left mid-merge. Its error
 * named neither: both attempts showed only the fetch's "From https://…" line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentSync } from "../src/sync/index.js";
import { gitCause } from "../src/sync/git-error.js";

const execFileAsync = promisify(execFile);
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
const git = (cwd: string, ...args: string[]) =>
  execFileAsync("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout.trim());

let dataDir: string;
let seedDir: string;
let syncRepo: string;
let sync: AgentSync;

// The sync's own commits take the identity git finds; the sync repo may not
// set one (sync-repo-trust.ts), so the test gives it the way a machine does.
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const [k, v] of Object.entries(IDENTITY)) { saved[k] = process.env[k]; process.env[k] = v; }
  dataDir = mkdtempSync(join(tmpdir(), "sync-diverge-"));
  const originDir = join(dataDir, "origin.git");
  seedDir = join(dataDir, "other-machine");
  mkdirSync(originDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  await git(originDir, "init", "--bare", "-b", "main");
  await git(seedDir, "init", "-b", "main");
  writeFileSync(join(seedDir, "notes.md"), "line one\n");
  writeFileSync(join(seedDir, "plan.md"), "the plan\n");
  await git(seedDir, "add", "-A");
  await git(seedDir, ...ID, "commit", "-m", "seed");
  await git(seedDir, "remote", "add", "origin", originDir);
  await git(seedDir, "push", "origin", "main");

  writeFileSync(join(dataDir, "sync-config.json"), JSON.stringify({ enabled: true, repoUrl: originDir }));
  sync = new AgentSync(dataDir, () => "test-token");
  expect(await sync.init()).toBe(true);
  syncRepo = join(dataDir, "sync-repo");
}, 30_000);

afterEach(() => {
  for (const k of Object.keys(IDENTITY)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("a sync whose commits conflict with another machine's", () => {
  it("merges both, deletes nothing the other side changed, and leaves no merge open", async () => {
    // The other machine changes both files and pushes first.
    writeFileSync(join(seedDir, "notes.md"), "line one\nfrom the other machine\n");
    writeFileSync(join(seedDir, "plan.md"), "the plan, revised elsewhere\n");
    await git(seedDir, "add", "-A");
    await git(seedDir, ...ID, "commit", "-m", "other machine");
    await git(seedDir, "push", "origin", "main");
    // This machine changed the same line and deleted the file the other revised.
    writeFileSync(join(syncRepo, "notes.md"), "line one\nfrom this machine\n");
    rmSync(join(syncRepo, "plan.md"));
    await git(syncRepo, "add", "-A");
    await git(syncRepo, "commit", "-m", "this machine");

    const out = await sync.push();

    expect(out, out.message).toMatchObject({ success: true });
    expect(existsSync(join(syncRepo, ".git", "MERGE_HEAD"))).toBe(false);
    await git(seedDir, "pull", "origin", "main");
    const notes = readFileSync(join(seedDir, "notes.md"), "utf-8");
    expect(notes).toContain("from this machine");
    expect(notes).toContain("from the other machine");
    expect(notes).not.toContain("<<<<<<<");
    expect(readFileSync(join(seedDir, "plan.md"), "utf-8")).toBe("the plan, revised elsewhere\n");
  }, 60_000);

  it("a merge an earlier sync left half done is undone at the next one", async () => {
    writeFileSync(join(seedDir, "notes.md"), "remote\n");
    await git(seedDir, "add", "-A");
    await git(seedDir, ...ID, "commit", "-m", "remote");
    await git(seedDir, "push", "origin", "main");
    writeFileSync(join(syncRepo, "notes.md"), "local\n");
    await git(syncRepo, "commit", "-am", "local");
    await git(syncRepo, "pull", "--no-rebase", "origin", "main").catch(() => undefined);
    expect(existsSync(join(syncRepo, ".git", "MERGE_HEAD"))).toBe(true);

    expect(await sync.init()).toBe(true);

    expect(existsSync(join(syncRepo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await git(syncRepo, "status", "--porcelain")).toBe("");
  }, 60_000);
});

describe("what a failed git command is reported as", () => {
  it("names the conflicting files, not the fetch's From line", () => {
    const pull = "git pull: From https://github.com/me/Memory\n * branch main -> FETCH_HEAD\nAuto-merging notes.md\nCONFLICT (content): Merge conflict in notes.md\nCONFLICT (modify/delete): plan.md deleted in HEAD and modified in abc.\nAutomatic merge failed; fix conflicts and then commit the result.";
    expect(gitCause(pull)).toBe("CONFLICT (content): Merge conflict in notes.md; CONFLICT (modify/delete): plan.md deleted in HEAD and modified in abc.");
    expect(gitCause("git push: To https://github.com/me/Memory.git\n ! [rejected] main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/me/Memory.git'"))
      .toBe("error: failed to push some refs to 'https://github.com/me/Memory.git'");
    expect(gitCause("git pull: From https://github.com/me/Memory\nerror: Your local changes to the following files would be overwritten by merge:\n\tnotes.md"))
      .toContain("would be overwritten by merge");
    // git prints CONFLICT lines to stdout; stderr holding only fetch progress is never shown as the cause.
    expect(gitCause("git pull: From https://github.com/me/Memory\n * branch            main       -> FETCH_HEAD")).not.toMatch(/From https|FETCH_HEAD/);
  });
});
