// The rolling pointer moves forward only, and a commit history no longer has
// cannot hold it in place (91cb7ff froze the channel 2026-10-07 to 2026-11-18).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHistory, pointerAdvanceVerdict } from "../scripts/rolling-pointer-advance.mjs";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
const commit = (name: string) => {
  writeFileSync(join(repo, name), name);
  git("add", name);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name);
  return git("rev-parse", "HEAD");
};

let base: string, head: string, sibling: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "pointer-advance-"));
  git("init", "-q", "-b", "main");
  base = commit("a");
  head = commit("b");
  git("checkout", "-q", "-b", "side", base);
  sibling = commit("c");
  git("checkout", "-q", "main");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("pointerAdvanceVerdict", () => {
  it("moves a pointer to a descendant of the commit it names", () => {
    expect(pointerAdvanceVerdict(base, head, gitHistory(repo))).toEqual({ advance: true });
  });

  it("moves a pointer that names nothing yet, or this commit already", () => {
    expect(pointerAdvanceVerdict("", head, gitHistory(repo))).toEqual({ advance: true });
    expect(pointerAdvanceVerdict(head, head, gitHistory(repo))).toEqual({ advance: true });
  });

  it("holds when this commit does not descend from the published one", () => {
    const verdict = pointerAdvanceVerdict(sibling, head, gitHistory(repo));
    expect(verdict.advance).toBe(false);
    expect(verdict.warning).toMatch(/does not descend/);
    expect(pointerAdvanceVerdict(head, base, gitHistory(repo)).advance).toBe(false);
  });

  it("moves past a published commit history no longer has, and says so", () => {
    const rewritten = "91cb7ff37ccd663a625560f040f9374ccbed50a4";
    const verdict = pointerAdvanceVerdict(rewritten, head, gitHistory(repo));
    expect(verdict.advance).toBe(true);
    expect(verdict.warning).toMatch(/in no branch/);
  });
});
