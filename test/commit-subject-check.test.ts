// The commit-msg hook rejects a subject that cites the size rule instead of
// naming the change, and leaves ordinary subjects alone (numbers, "lines" of
// output, "loc" as a word). Run end to end too: the hook block is what
// install-git-hooks.mjs installs, and it must exit non-zero to stop a commit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { citesSizeRule, commitSubject } from "../scripts/check-commit-subject.mjs";

const script = fileURLToPath(new URL("../scripts/check-commit-subject.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("citesSizeRule", () => {
  it.each([
    "refactor(turn-loop): split driveTurn (under 400-LOC gate)",
    "chore: trim comments to fit the 400-line cap",
    "refactor: split foo.ts to stay under 400 lines",
    "chore(map): file size gate for desktop/",
    "fix: the size cap counts desktop/src too",
    "refactor: carve the parser out to get below the 350 code-line limit",
    "refactor(tools): shrink registry.ts under the cap",
    "split X — 412 LOC",
  ])("rejects %s", (subject) => {
    expect(citesSizeRule(subject)).toBe(true);
  });

  it.each([
    "fix(chat): the stream 400'd every turn",
    "fix(log): keep the last 500 lines of output",
    "feat(viewer): tail 200 lines of the server log",
    "fix(routes): render the 404 page",
    "perf: keep latency under 400ms",
    "feat(i18n): loc strings for fr",
    "fix(api): honor rate limit headers",
    "style: line height on mobile",
    "refactor(retry): the retry policy gets its own module",
  ])("accepts %s", (subject) => {
    expect(citesSizeRule(subject)).toBe(false);
  });

  it("reads the subject past blank and comment lines", () => {
    expect(commitSubject("\n# Please enter the commit message\nfeat: x\n\nbody")).toBe("feat: x");
  });
});

describe("the hook script", () => {
  function hook(message: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "lax-commit-msg-"));
    dirs.push(dir);
    writeFileSync(join(dir, "COMMIT_EDITMSG"), message);
    return spawnSync(process.execPath, [script, join(dir, "COMMIT_EDITMSG")], { encoding: "utf-8", env: { ...process.env, ...env } });
  }

  it("exits 1 with the reason on a size-rule subject, 0 otherwise, 0 when bypassed", () => {
    const bad = hook("refactor: split foo (400-LOC cap)\n");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("Name the commit after what changed and why");
    expect(hook("feat(retry): the retry policy gets its own module\n").status).toBe(0);
    expect(hook("refactor: split foo (400-LOC cap)\n", { SKIP_COMMIT_SUBJECT_CHECK: "1" }).status).toBe(0);
  });
});
