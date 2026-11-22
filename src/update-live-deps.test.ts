// Whether there is an update, against real git: an install whose own commit
// reached origin/main as a copy (new id, same change) has nothing to take.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upstreamChangesMissing } from "./update-live-deps.js";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
let root = "";
let install = "";
let upstream = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf-8" }).trim();
}

/** Land the install's commit on upstream as a copy. The committer date is pinned
 *  apart from the original's, which a same-second cherry-pick would otherwise
 *  share — giving the copy the very same id. */
function pushCopyOf(sha: string): void {
  git(upstream, "fetch", "-q", install, sha);
  execFileSync("git", ["cherry-pick", sha], {
    cwd: upstream, env: { ...process.env, ...IDENTITY, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" }, stdio: "ignore",
  });
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** One commit writing several files (folders made as needed). */
function commitFiles(cwd: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", file);
  }
  git(cwd, "commit", "-q", "-m", "edit " + Object.keys(files).join(", "));
}

/** Push from the upstream clone, then fetch it into the install. */
function publish(): void {
  git(upstream, "push", "-q", "origin", "HEAD:main");
  git(install, "fetch", "-q", "origin", "main");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-upstream-missing-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  install = join(root, "install");
  upstream = join(root, "upstream");
  git(root, "init", "-q", "-b", "main", upstream);
  git(upstream, "remote", "add", "origin", origin);
  commit(upstream, "a.txt", "a");
  git(upstream, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, install);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("upstreamChangesMissing", () => {
  it("is 0 when the install is on origin/main", async () => {
    expect(await upstreamChangesMissing(install)).toBe(0);
  });

  it("counts each new commit on origin/main", async () => {
    commit(upstream, "b.txt", "b");
    commit(upstream, "c.txt", "c");
    publish();
    expect(await upstreamChangesMissing(install)).toBe(2);
  });

  it("is 0 when origin/main has only copies of the install's own commits", async () => {
    const own = commit(install, "fix.txt", "fix");
    commit(install, "local.txt", "not pushed");
    pushCopyOf(own);
    publish();
    expect(git(install, "rev-list", "--count", "HEAD..origin/main")).toBe("1"); // what the id count saw
    expect(await upstreamChangesMissing(install)).toBe(0);
  });

  it("still counts a real change that arrived beside a copy", async () => {
    pushCopyOf(commit(install, "fix.txt", "fix"));
    commit(upstream, "new.txt", "new");
    publish();
    expect(await upstreamChangesMissing(install)).toBe(1);
  });
  it("is 0 when origin's copy differs from the install's only in regenerated files", async () => {
    // The same fix made on two bases: the source is identical, the codebase
    // map and the size ratchet that each build rewrote are not.
    commitFiles(install, { "fix.txt": "fix", "docs/codebase-map.md": "map as built here", ".code-size-ratchet": "a 10" });
    commitFiles(upstream, { "fix.txt": "fix", "docs/codebase-map.md": "map as built there", ".code-size-ratchet": "a 12" });
    publish();
    expect(git(install, "rev-list", "--count", "--right-only", "--cherry-pick", "HEAD...origin/main")).toBe("1"); // what git's match saw
    expect(await upstreamChangesMissing(install)).toBe(0);
  });

  it("still counts a source change that arrived with its regenerated files", async () => {
    commitFiles(install, { "fix.txt": "fix" });
    commitFiles(upstream, { "other.txt": "other", "docs/codebase-map.md": "map" });
    publish();
    expect(await upstreamChangesMissing(install)).toBe(1);
  });

  it("a commit that only regenerates docs is not an update", async () => {
    commitFiles(install, { "fix.txt": "fix" });
    commitFiles(upstream, { "docs/codebase-map.md": "map refreshed" });
    publish();
    expect(await upstreamChangesMissing(install)).toBe(0);
  });
});
