/**
 * The change set comes from real git against a local bare remote — no network.
 * Each case builds the repository state a publish would start from and checks
 * that the change set names exactly what would ship.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChangeSet } from "./change-set.js";
import { changeSetIsEmpty } from "./change-set-types.js";
import type { PublishOperation } from "../publish-operation.js";

let root: string;
let remote: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(work, file), content);
  git(work, "add", file);
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function push(pushArgs: string[], cwd = work): PublishOperation {
  return { kind: "git-push", label: ["git push", ...pushArgs].join(" "), tool: "bash", cwd, pushArgs };
}

function deploy(cwd = work): PublishOperation {
  return { kind: "deploy", label: "vercel --prod", tool: "bash", cwd };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-changeset-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# app\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  work = join(root, "work");
  git(root, "clone", "-q", remote, work);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeChangeSet — git push", () => {
  it("a new branch is reviewed from its merge-base with the remote default branch", async () => {
    git(work, "checkout", "-q", "-b", "feature");
    commit("policy.sql", "create policy all_read on emails for select using (true);\n", "add emails policy");
    commit("send.ts", "export const send = 1;\n", "add sender");
    const cs = await computeChangeSet([push(["-u", "origin", "feature"])]);
    expect(cs.unknown).toEqual([]);
    const [part] = cs.parts;
    expect(part.refs).toEqual([expect.objectContaining({ remoteRef: "refs/heads/feature", status: "new" })]);
    expect(part.commits.map((c) => c.subject)).toEqual(["add emails policy", "add sender"]);
    expect(part.files.map((f) => f.path).sort()).toEqual(["policy.sql", "send.ts"]);
    expect(part.fileDiffs.find((d) => d.path === "policy.sql")?.text).toContain("+create policy all_read");
    expect(part.baseLabel).toContain("origin/main");
    // The dry run's -u did not configure an upstream.
    expect(() => git(work, "rev-parse", "--abbrev-ref", "feature@{u}")).toThrow();
  });

  it("a fast-forward is reviewed old..new, and only the new commits", async () => {
    commit("a.ts", "export const a = 1;\n", "one");
    git(work, "push", "-q", "origin", "main");
    const newSha = commit("b.ts", "export const b = 2;\n", "two");
    const cs = await computeChangeSet([push([])]);
    const [part] = cs.parts;
    expect(part.refs?.[0]).toMatchObject({ status: "fast-forward", newSha });
    expect(part.commits.map((c) => c.subject)).toEqual(["two"]);
    expect(part.files).toEqual([{ status: "A", path: "b.ts" }]);
  });

  it("names every ref a multi-ref push would update", async () => {
    commit("a.ts", "1\n", "main work");
    git(work, "checkout", "-q", "-b", "side");
    commit("s.ts", "2\n", "side work");
    const cs = await computeChangeSet([push(["origin", "main", "side"])]);
    const refs = cs.parts[0].refs!.map((r) => [r.remoteRef, r.status]).sort();
    expect(refs).toEqual([["refs/heads/main", "fast-forward"], ["refs/heads/side", "new"]]);
    expect(cs.parts[0].commits.map((c) => c.subject).sort()).toEqual(["main work", "side work"]);
  });

  it("an up-to-date push ships nothing", async () => {
    const cs = await computeChangeSet([push([])]);
    expect(cs.parts[0].refs?.[0].status).toBe("up-to-date");
    expect(changeSetIsEmpty(cs)).toBe(true);
  });

  it("refuses a dry run that would execute a program", async () => {
    const cs = await computeChangeSet([push(["--receive-pack=touch pwned", "origin", "main"])]);
    expect(cs.parts).toEqual([]);
    expect(cs.unknown[0].reason).toMatch(/receive-pack/);
  });

  it("no test's dry run reaches a network remote (test-env.ts GIT_ALLOW_PROTOCOL)", async () => {
    const cs = await computeChangeSet([push(["https://example.invalid/acme/app.git", "main"])]);
    expect(cs.unknown[0].reason).toMatch(/transport 'https' not allowed/);
  });

  it("a push git cannot dry-run is unknown, with git's reason", async () => {
    const cs = await computeChangeSet([push(["no-such-remote", "main"])]);
    expect(cs.parts).toEqual([]);
    expect(cs.unknown[0].reason).toMatch(/dry-run failed/);
  });

  it("the fingerprint is stable for the same change set and moves when the diff does", async () => {
    commit("a.ts", "1\n", "one");
    const a = await computeChangeSet([push([])]);
    const b = await computeChangeSet([push([])]);
    expect(b.fingerprint).toBe(a.fingerprint);
    commit("a.ts", "2\n", "two");
    const c = await computeChangeSet([push([])]);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("computeChangeSet — deploy (working tree ships)", () => {
  it("includes unpushed commits, uncommitted edits, and untracked files", async () => {
    commit("app.ts", "export const v = 1;\n", "unpushed");
    writeFileSync(join(work, "README.md"), "# app\nedited\n");
    writeFileSync(join(work, "new-secret.ts"), "export const key = 'sk_live_x';\n");
    const cs = await computeChangeSet([deploy()]);
    const [part] = cs.parts;
    expect(part.includesWorkingTree).toBe(true);
    expect(part.commits.map((c) => c.subject)).toEqual(["unpushed"]);
    expect(part.files).toEqual(expect.arrayContaining([
      { status: "A", path: "app.ts" },
      { status: "M", path: "README.md" },
      { status: "??", path: "new-secret.ts" },
    ]));
    expect(part.fileDiffs.find((d) => d.path === "new-secret.ts")?.text).toContain("+export const key");
    expect(part.baseLabel).toContain("origin/main");
  });

  it("a branch with no upstream compares against the remote default branch", async () => {
    git(work, "checkout", "-q", "-b", "local-only");
    commit("x.ts", "x\n", "local commit");
    const [part] = (await computeChangeSet([deploy()])).parts;
    expect(part.baseLabel).toContain("remote's default branch");
    expect(part.commits.map((c) => c.subject)).toEqual(["local commit"]);
  });

  it("an edit to an untracked file changes the fingerprint", async () => {
    writeFileSync(join(work, "draft.ts"), "1\n");
    const a = await computeChangeSet([deploy()]);
    writeFileSync(join(work, "draft.ts"), "2\n");
    const b = await computeChangeSet([deploy()]);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("a repository with no remote ships its whole tree", async () => {
    const solo = join(root, "solo");
    mkdirSync(solo);
    git(solo, "init", "-q", "-b", "main");
    writeFileSync(join(solo, "index.html"), "<h1>hi</h1>\n");
    git(solo, "add", "index.html");
    git(solo, "commit", "-q", "-m", "site");
    const [part] = (await computeChangeSet([deploy(solo)])).parts;
    expect(part.baseLabel).toMatch(/whole tree/);
    expect(part.files).toEqual([{ status: "A", path: "index.html" }]);
  });

  it("a directory that is not a git repository is unknown, never passed", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const cs = await computeChangeSet([deploy(plain)]);
    expect(cs.parts).toEqual([]);
    expect(cs.unknown).toEqual([expect.objectContaining({ label: "vercel --prod", reason: expect.stringMatching(/not inside a git repository/) })]);
    expect(changeSetIsEmpty(cs)).toBe(false);
  });

  it("a runtime-expanded directory is unknown", async () => {
    const cs = await computeChangeSet([{ ...deploy(), cwdUncertain: true }]);
    expect(cs.unknown[0].reason).toMatch(/run time/);
  });
});

describe("computeChangeSet — releases", () => {
  it("gh release create reviews the commits since the previous tag", async () => {
    commit("a.ts", "1\n", "before tag");
    git(work, "tag", "v1.0.0");
    commit("b.ts", "2\n", "after tag");
    const [part] = (await computeChangeSet([{ kind: "release", label: "gh release create", tool: "bash", cwd: work, explicitTarget: "v1.1.0" }])).parts;
    expect(part.baseLabel).toContain("v1.0.0");
    expect(part.commits.map((c) => c.subject)).toEqual(["after tag"]);
    expect(part.includesWorkingTree).toBe(false);
  });

  it("gh pr merge <number> is unknown — its diff is not local", async () => {
    const cs = await computeChangeSet([{ kind: "release", label: "gh pr merge", tool: "bash", cwd: work, explicitTarget: "42" }]);
    expect(cs.unknown[0].reason).toMatch(/pull request/);
  });
});
