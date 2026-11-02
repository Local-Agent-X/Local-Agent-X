// The worktree fence: a session working in a git worktree reads the repository
// it was cut from but changes files only in its worktree. Each case is a way
// the 2026-10-25 audit found to write into the parent checkout.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAN_CREATE_DIRECTORY_LINK } from "../../symlink-capabilities.test-helper.js";
import { fenceCallRefusal, fenceShellRefusal, fenceWriteRefusal, type WorktreeFence } from "./worktree-fence.js";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "lax-fence-")));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));
const repo = join(BASE, "repo");
const wt = join(BASE, "worktrees", "agent-1");
const elsewhere = join(BASE, "elsewhere");
for (const d of [join(repo, "src"), join(wt, "src"), join(wt, "sub"), elsewhere]) mkdirSync(d, { recursive: true });
const fence: WorktreeFence = { worktree: wt, repoRoot: repo };
const q = (p: string) => JSON.stringify(p);

describe("worktree fence — file tools", () => {
  it("refuses a write into the parent repo and names the same path in the worktree", () => {
    const refused = fenceWriteRefusal(fence, join(repo, "src", "a.ts"));
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toContain(join(wt, "src", "a.ts"));
  });

  it("lets a write into the worktree or anywhere outside the repo through", () => {
    expect(fenceWriteRefusal(fence, join(wt, "src", "a.ts"))).toBeNull();
    expect(fenceWriteRefusal(fence, join(elsewhere, "out.txt"))).toBeNull();
  });

  it("a worktree nested inside the repo is still the agent's", () => {
    const nested: WorktreeFence = { worktree: join(repo, ".worktrees", "a"), repoRoot: repo };
    expect(fenceWriteRefusal(nested, join(repo, ".worktrees", "a", "x.ts"))).toBeNull();
    expect(fenceWriteRefusal(nested, join(repo, "x.ts"))).not.toBeNull();
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("a link inside the worktree that points into the repo is the repo", () => {
    const link = join(wt, "linked");
    symlinkSync(join(repo, "src"), link, "junction");
    expect(fenceWriteRefusal(fence, join(link, "a.ts"))).not.toBeNull();
  });

  it("judges a call by its row: a read of the repo passes, a write is refused", () => {
    expect(fenceCallRefusal(fence, "read", { path: join(repo, "src", "a.ts") }, BASE, "s")).toBeNull();
    expect(fenceCallRefusal(fence, "write", { path: join(repo, "src", "a.ts"), content: "x" }, BASE, "s")).not.toBeNull();
  });
});

describe("worktree fence — shell", () => {
  const refused = (command: string, base = wt) => fenceShellRefusal(fence, command, base) !== null;

  it("refuses a command that can write after cd into the repo, with && or ;", () => {
    expect(refused(`cd ${q(repo)} && git commit -am wip`)).toBe(true);
    expect(refused(`cd ${q(repo)}; npm install`)).toBe(true);
    expect(refused(`cd ${q(repo)} && make`)).toBe(true);
  });

  it("refuses git -C at the repo for a command that changes it, allows one that reads", () => {
    expect(refused(`git -C ${q(repo)} commit -am wip`)).toBe(true);
    expect(refused(`git -C ${q(repo)} checkout -b x`)).toBe(true);
    expect(refused(`git -C ${q(repo)} log --oneline -5`)).toBe(false);
    expect(refused(`git -C ${q(repo)} status`)).toBe(false);
  });

  it("lets the agent read the repo from inside it", () => {
    expect(refused(`cd ${q(repo)} && ls -la && grep -rn foo src && git diff HEAD~1 && cat README.md`)).toBe(false);
    expect(refused(`cd ${q(repo)} && find . -name "*.ts"`)).toBe(false);
    expect(refused(`cd ${q(repo)} && find . -name "*.tmp" -delete`)).toBe(true);
  });

  it("refuses a redirect or a destination into the repo from anywhere", () => {
    expect(refused(`echo hi > ${q(join(repo, "f.txt"))}`)).toBe(true);
    expect(refused(`cd ${q(repo)} && cat README.md > notes.txt`)).toBe(true);
    expect(refused(`cp out.txt ${q(join(repo, "out.txt"))}`)).toBe(true);
    expect(refused(`node build.js --out=${join(repo, "dist")}`)).toBe(true);
  });

  it("lets a copy FROM the repo into the worktree, and a redirect to /dev/null, through", () => {
    expect(refused(`cp ${q(join(repo, "README.md"))} ./README.md`)).toBe(false);
    expect(refused(`cd ${q(repo)} && git log > /dev/null`)).toBe(false);
  });

  it("works in the worktree as before, including `cd sub; cmd`", () => {
    expect(refused("npm test && git commit -am wip")).toBe(false);
    expect(refused("cd sub; npm test")).toBe(false);
    expect(refused(`cd ${q(elsewhere)} && make`)).toBe(false);
  });

  it("refuses a command that can write after a cd it cannot place, not one that only reads", () => {
    expect(refused("cd $REPO && make")).toBe(true);
    expect(refused("cd ~/project && npm install")).toBe(true);
    expect(refused("cd $REPO && ls")).toBe(false);
  });

  it("sees into a nested shell body", () => {
    expect(refused(`bash -c "cd ${repo.replace(/\\/g, "/")} && rm -rf build"`)).toBe(true);
  });

  it("a process started with its folder in the repo is refused; one in the worktree is not", () => {
    expect(fenceCallRefusal(fence, "process_start", { command: "npm run dev", cwd: repo }, BASE, "s")).not.toBeNull();
    expect(fenceCallRefusal(fence, "process_start", { command: "npm run dev", cwd: wt }, BASE, "s")).toBeNull();
  });
});
