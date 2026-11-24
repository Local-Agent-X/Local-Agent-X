/**
 * A check run on the base project tree leaves it as the last merge left it
 * (label-check, 2026-11-23). The merged re-gate runs the project's own build,
 * and the structure kit's check rewrites docs/codebase-map.md on every run:
 * left on base, it read as uncommitted changes and the next reviewed chunk's
 * merge was refused. What the check rewrote is put back; what was already
 * changed before it, and any untracked file, is left alone.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// git runs through the caged-spawn seam; the sandbox facade passes the program
// through, so every git below is real (as in auto-build-git-baseline.test.ts).
vi.mock("../src/sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => "host",
    ensureWinCageGrants: async () => {},
    wrapSpawnForSandbox: (file: string, args: string[]) => ({ cmd: file, args }),
  };
});
vi.mock("../src/tools/shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));

import { leavingTrackedFilesAsFound } from "../src/auto-build/git-helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(): { dir: string; g: (args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "lax-tree-as-found-"));
  dirs.push(dir);
  const g = (args: string[]) => execFileSync("git", args, {
    cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["config", "core.autocrlf", "true"]);
  writeFileSync(join(dir, "map.md"), "a\nb\n");
  writeFileSync(join(dir, "app.ts"), "export const v = 1;\n");
  writeFileSync(join(dir, "user.ts"), "export const u = 1;\n");
  g(["add", "."]);
  g(["commit", "-qm", "base"]);
  return { dir, g };
}

describe("leavingTrackedFilesAsFound", () => {
  it("puts back what the check rewrote, and leaves the user's change and new files alone", async () => {
    const { dir, g } = repo();
    writeFileSync(join(dir, "user.ts"), "export const u = 2; // the user's edit\n");

    const { value, restored } = await leavingTrackedFilesAsFound(dir, async () => {
      writeFileSync(join(dir, "map.md"), "a\nb\nregenerated\n");
      writeFileSync(join(dir, "user.ts"), "export const u = 3;\n");
      writeFileSync(join(dir, "report.txt"), "new\n");
      return "ran";
    });

    expect(value).toBe("ran");
    expect(restored).toEqual(["map.md"]);
    expect(readFileSync(join(dir, "map.md"), "utf8").replace(/\r\n/g, "\n")).toBe("a\nb\n");
    expect(readFileSync(join(dir, "user.ts"), "utf8")).toContain("u = 3");
    expect(existsSync(join(dir, "report.txt"))).toBe(true);
    expect(g(["status", "--porcelain", "--untracked-files=no"])).toBe("M user.ts");
  });

  it("puts back a file rewritten with its same content, which git status still reads as modified", async () => {
    const { dir, g } = repo();
    // As checked out, map.md has CRLF (autocrlf); the kit writes it with LF.
    rmSync(join(dir, "map.md"));
    g(["checkout", "--", "map.md"]);

    const { restored } = await leavingTrackedFilesAsFound(dir, async () => {
      writeFileSync(join(dir, "map.md"), "a\nb\n");
    });

    expect(restored).toEqual(["map.md"]);
    expect(g(["status", "--porcelain", "--untracked-files=no"])).toBe("");
  });

  it("runs the check as is outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-tree-as-found-nogit-"));
    dirs.push(dir);
    const { value, restored } = await leavingTrackedFilesAsFound(dir, async () => 42);
    expect(value).toBe(42);
    expect(restored).toEqual([]);
  });
});
