import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workTreeFingerprint } from "./work-tree-fingerprint.js";

const repo = mkdtempSync(join(tmpdir(), "lax-tree-fingerprint-"));
const plain = mkdtempSync(join(tmpdir(), "lax-tree-fingerprint-plain-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args]);
git("init", "-q");
writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "base");

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

describe("workTreeFingerprint", () => {
  it("is stable while nothing changes and moves when a file is written", () => {
    const before = workTreeFingerprint(repo);
    expect(before).toBe(workTreeFingerprint(repo));
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    const added = workTreeFingerprint(repo);
    expect(added).not.toBe(before);
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    expect(workTreeFingerprint(repo)).not.toBe(added);
  });

  it("is null off a git root", () => {
    expect(workTreeFingerprint(plain)).toBeNull();
  });
});
