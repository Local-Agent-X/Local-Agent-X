// The size gate reads each changed file's line count at HEAD. The file names
// are whatever the round's agent created, so the read must never hand one to a
// shell: a name carrying $( ) or backticks would run as a command on the host.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { activeWorktrees } from "../agency/worktree-core.js";
import { validateRound } from "./validate.js";
import { KIT_LIMITS } from "../app-scaffold/kit-size.js";
import type { AutopilotConfig } from "./types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const lines = (n: number): string => "line\n".repeat(n);

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
}

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "lax-autopilot-validate-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function config(repo: string, name: string, fileSizeLimit: number): AutopilotConfig {
  return {
    topic: "t", scope: [], durationMs: 60_000, maxRounds: 1, maxNoopRounds: 1, maxSelfEditCalls: 0, withTests: false,
    worktreePath: repo, worktreeName: name, branchName: "main", baseBranch: "main",
    buildCommand: null, buildTimeoutMs: 1_000, testCommand: "", testTimeoutMs: 1_000, fileSizeLimit,
  };
}

describe("validateRound under the shift's signal", () => {
  it("a build stopped by the signal is 'stopped', not a failed build, and the round's edits stay", async () => {
    const repo = repoWith({ "a.ts": lines(1) });
    writeFileSync(join(repo, "a.ts"), lines(3));
    git(repo, "add", "-A");
    const name = `validate-${process.pid}-${Date.now()}-stop`;
    activeWorktrees.set(name, { path: repo, branch: "main", baseBranch: "main", repoRoot: repo, mergedSuccessfully: false });
    cleanups.push(() => activeWorktrees.delete(name));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await validateRound(name, {
      ...config(repo, name, 400),
      buildCommand: `node -e "setTimeout(function () {}, 60000)"`,
      buildTimeoutMs: 30_000,
    }, controller.signal);

    expect(result.outcome).toBe("stopped");
    expect(readFileSync(join(repo, "a.ts"), "utf-8")).toBe(lines(3));
  });
});

describe("validateRound size gate", () => {
  it("measures a file named with $( ) and backticks at HEAD without running either as a command", async () => {
    // A shell would run both substitutions and measure "abc.ts" instead: already
    // over the limit, so the gate would wave the oversized change through. No
    // spaces in the name: porcelain quotes those, and the gate reads it raw.
    const weird = "abc$(true)`true`.ts";
    const repo = repoWith({ [weird]: lines(10), "abc.ts": lines(100) });
    writeFileSync(join(repo, weird), lines(20));
    // Staged: the status reader trims its output, which eats the leading
    // blank of an unstaged first entry (" M") along with the name's first byte.
    git(repo, "add", "-A");
    const name = `validate-${process.pid}-${Date.now()}`;
    activeWorktrees.set(name, { path: repo, branch: "main", baseBranch: "main", repoRoot: repo, mergedSuccessfully: false });
    cleanups.push(() => activeWorktrees.delete(name));

    const result = await validateRound(name, config(repo, name, 15));

    expect(result.outcome).toBe("failed-size");
    expect(result.oversizedFiles).toEqual([`${weird} (20 code lines, cap 15)`]);
  });

  // The gate applies the kit's rule (app-scaffold/kit-size.ts), not a count of
  // its own: code lines only, and functions too.
  async function roundOn(files: Record<string, string>, edits: Record<string, string>, fileCap: number) {
    const repo = repoWith(files);
    for (const [rel, text] of Object.entries(edits)) writeFileSync(join(repo, rel), text);
    git(repo, "add", "-A");
    const name = `validate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeWorktrees.set(name, { path: repo, branch: "main", baseBranch: "main", repoRoot: repo, mergedSuccessfully: false });
    cleanups.push(() => activeWorktrees.delete(name));
    return validateRound(name, config(repo, name, fileCap));
  }
  const fn = (n: number) => `export function grow() {\n${"  call();\n".repeat(n)}}\n`;

  it("holds a function to the kit's function cap, and counts no comment line", async () => {
    const result = await roundOn(
      { "a.ts": fn(10), "notes.ts": "export const x = 1;\n" },
      { "a.ts": fn(KIT_LIMITS.maxFn + 5), "notes.ts": "// why it is so\n".repeat(500) + "export const x = 1;\n" },
      400,
    );
    expect(result.outcome).toBe("failed-size");
    expect(result.oversizedFiles).toEqual([`a.ts#grow (${KIT_LIMITS.maxFn + 7} own code lines, cap ${KIT_LIMITS.maxFn})`]);
  });

  it("lets a round edit a file that was already over its cap", async () => {
    const result = await roundOn({ "big.ts": lines(30) }, { "big.ts": lines(31) }, 15);
    expect(result.outcome).not.toBe("failed-size");
  });
});
