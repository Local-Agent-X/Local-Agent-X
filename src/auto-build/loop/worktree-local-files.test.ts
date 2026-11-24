// A chunk's worktree holds what git tracks, so the config a project ignores on
// purpose (a service config, an env file) was missing there and the chunk's
// build failed for it (label-check 2026-11-22). Real git, a real worktree.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLocalFiles } from "./worktree-local-files.js";

let root: string;
let repo: string;
let worktree: string;
const g = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-local-files-"));
  repo = join(root, "project");
  worktree = join(root, "worktree");
  mkdirSync(join(repo, "android", "app"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, ".gitignore"), ["node_modules/", "dist/", ".env", "google-services.json", ".firebase-web.json", "*.bin", ".lax-build-history.json", ""].join("\n"));
  writeFileSync(join(repo, "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, "android", "app", "build.gradle"), "// tracked\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  // What the project has locally and git does not carry.
  writeFileSync(join(repo, ".env"), "EXPO_PUBLIC_SITE_KEY=placeholder\n");
  writeFileSync(join(repo, ".firebase-web.json"), "{}\n");
  writeFileSync(join(repo, "android", "app", "google-services.json"), '{"project_info":{}}\n');
  writeFileSync(join(repo, ".lax-build-history.json"), "{}\n");
  writeFileSync(join(repo, "model.bin"), Buffer.alloc(1024 * 1024 + 1));
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist", "bundle.js"), "built\n");
  g(repo, "worktree", "add", "-q", "-b", "autobuild/c9", worktree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("copyLocalFiles", () => {
  it("copies the project's ignored config files to where the worktree expects them", () => {
    const copied = copyLocalFiles(repo, worktree).sort();
    expect(copied).toEqual([".env", ".firebase-web.json", "android/app/google-services.json"]);
    expect(readFileSync(join(worktree, "android", "app", "google-services.json"), "utf-8")).toBe('{"project_info":{}}\n');
    expect(readFileSync(join(worktree, ".env"), "utf-8")).toBe("EXPO_PUBLIC_SITE_KEY=placeholder\n");
  });

  it("leaves ignored folders, the engine's own state and anything too large to be config", () => {
    copyLocalFiles(repo, worktree);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, "dist"))).toBe(false);
    expect(existsSync(join(worktree, ".lax-build-history.json"))).toBe(false);
    expect(existsSync(join(worktree, "model.bin"))).toBe(false);
  });

  it("the copies are ignored in the worktree too, so no merge carries one back", () => {
    copyLocalFiles(repo, worktree);
    expect(g(worktree, "status", "--porcelain")).toBe("");
  });

  it("never replaces a file the worktree already has", () => {
    writeFileSync(join(worktree, ".env"), "the chunk's own\n");
    expect(copyLocalFiles(repo, worktree)).not.toContain(".env");
    expect(readFileSync(join(worktree, ".env"), "utf-8")).toBe("the chunk's own\n");
  });

  it("a folder that is not a git project copies nothing and does not throw", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(copyLocalFiles(plain, worktree)).toEqual([]);
  });
});
