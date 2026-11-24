// A chunk built in the project tree that is still not green used to halt the
// build, because its unfinished work sat in the tree every later chunk builds
// in. Its work is now moved onto a branch and the tree put back. Real git.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSetAsideCase, parkTreeWork } from "./tree-set-aside.js";

let repo: string;
const g = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const chunk = { number: 3, title: "Matching" };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "lax-tree-set-aside-"));
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  g(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.lax-build-history.json\n");
  writeFileSync(join(repo, "app.ts"), "export const app = 1;\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("parkTreeWork", () => {
  it("moves the chunk's uncommitted work onto a branch and puts the tree back", () => {
    const preSha = g(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "app.ts"), "export const app = 2;\n");
    writeFileSync(join(repo, "match.ts"), "export const match = () => [];\n");

    const branch = parkTreeWork(repo, chunk, preSha);

    expect(branch).toBe("autobuild/c3");
    expect(g(repo, "rev-parse", "HEAD")).toBe(preSha);
    expect(g(repo, "branch", "--show-current")).toBe("main");
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe("export const app = 1;\n");
    expect(existsSync(join(repo, "match.ts"))).toBe(false);
    // The work is whole on the branch.
    expect(g(repo, "show", "autobuild/c3:match.ts")).toBe("export const match = () => [];");
    expect(g(repo, "show", "autobuild/c3:app.ts")).toBe("export const app = 2;");
    expect(g(repo, "log", "-1", "--format=%s", "autobuild/c3")).toBe("chunk 3 (set aside): Matching");
  });

  it("keeps what the worker committed itself, and what it left uncommitted, together", () => {
    const preSha = g(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "match.ts"), "one\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "the worker's own commit");
    writeFileSync(join(repo, "match.test.ts"), "two\n");

    expect(parkTreeWork(repo, chunk, preSha)).toBe("autobuild/c3");
    expect(g(repo, "rev-parse", "HEAD")).toBe(preSha);
    expect(g(repo, "show", "autobuild/c3:match.ts")).toBe("one");
    expect(g(repo, "show", "autobuild/c3:match.test.ts")).toBe("two");
  });

  it("leaves what git ignores where it is: the build's own state and installed packages", () => {
    const preSha = g(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "pkg.js"), "installed\n");
    writeFileSync(join(repo, ".lax-build-history.json"), '{"haltHistory":[]}\n');
    writeFileSync(join(repo, "match.ts"), "one\n");

    parkTreeWork(repo, chunk, preSha);
    expect(existsSync(join(repo, "node_modules", "pkg.js"))).toBe(true);
    expect(readFileSync(join(repo, ".lax-build-history.json"), "utf-8")).toBe('{"haltHistory":[]}\n');
  });

  it("a chunk that wrote nothing leaves no branch", () => {
    const preSha = g(repo, "rev-parse", "HEAD");
    expect(parkTreeWork(repo, chunk, preSha)).toBeUndefined();
    expect(g(repo, "branch", "--list", "autobuild/*")).toBe("");
  });

  it("never reuses a branch that holds an earlier run's unmerged work", () => {
    const preSha = g(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "match.ts"), "the first run\n");
    expect(parkTreeWork(repo, chunk, preSha)).toBe("autobuild/c3");
    writeFileSync(join(repo, "match.ts"), "the second run\n");
    expect(parkTreeWork(repo, chunk, preSha)).toBe("autobuild/c3-2");
    expect(g(repo, "show", "autobuild/c3:match.ts")).toBe("the first run");
    expect(g(repo, "show", "autobuild/c3-2:match.ts")).toBe("the second run");
  });

  it("refuses a project that is a folder of a larger repository, and touches nothing", () => {
    mkdirSync(join(repo, "apps", "site"), { recursive: true });
    writeFileSync(join(repo, "apps", "site", "index.ts"), "export {};\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "a nested project");
    const preSha = g(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "apps", "site", "index.ts"), "export const changed = 1;\n");
    writeFileSync(join(repo, "app.ts"), "someone else's edit\n");

    expect(() => parkTreeWork(join(repo, "apps", "site"), chunk, preSha)).toThrow(/inside a larger git repository/);
    expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe("someone else's edit\n");
    expect(readFileSync(join(repo, "apps", "site", "index.ts"), "utf-8")).toBe("export const changed = 1;\n");
    expect(g(repo, "rev-parse", "HEAD")).toBe(preSha);
  });
});

describe("isSetAsideCase", () => {
  it("a chunk that was not accepted is set aside; an accepted one, a phase pause and a cancel are not", () => {
    expect(isSetAsideCase("halt", false)).toBe(true);
    expect(isSetAsideCase("push_back", false)).toBe(true);
    expect(isSetAsideCase("proceed", false)).toBe(false);
    expect(isSetAsideCase("amend_spec", false)).toBe(false);
    expect(isSetAsideCase("halt", true)).toBe(false);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(isSetAsideCase("halt", false, cancelled.signal)).toBe(false);
  });
});
