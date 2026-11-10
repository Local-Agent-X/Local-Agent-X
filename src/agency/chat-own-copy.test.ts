import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import { anchorOwnCopy, leaveOwnCopy, mergeOwnCopy, ownCopyFolder, ownCopyOf, startOwnCopy, _setOwnCopyFileForTest } from "./chat-own-copy.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "./work-claims.js";
import { _resetHandoverNotesForTest, _setHandoverNotesForTest } from "./handover-notes.js";
import { _resetRepoLocateCacheForTest } from "./repo-locate.js";
import { otherAgentsSection, _resetOtherAgentsBlockForTest } from "./other-agents-block.js";

let repo: string;
let session: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function commit(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(join(cwd, file), body);
  g(cwd, "add", "-A");
  g(cwd, "commit", "-q", "-m", msg);
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-own-copy-"));
  repo = join(root, "repo");
  session = `chat-${Math.random().toString(36).slice(2)}`;
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.name", "t"); g(repo, "config", "user.email", "t@t"); g(repo, "config", "commit.gpgsign", "false");
  // Bytes in, bytes out: the assertions compare file contents across checkouts.
  g(repo, "config", "core.autocrlf", "false");
  commit(repo, "app.ts", "one\ntwo\nthree\n", "base");
  _setOwnCopyFileForTest(join(root, "session-worktrees.json"));
  _resetRepoLocateCacheForTest(); _resetOtherAgentsBlockForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => ({ id, lane: "interactive", status: "completed", task: "t" }) as unknown as Op });
  _setHandoverNotesForTest({ dir: join(root, "notes") });
});
afterEach(() => {
  try { leaveOwnCopy(session); } catch { /* already gone */ }
  _setOwnCopyFileForTest(null); _resetWorkClaimsForTest(); _resetHandoverNotesForTest();
});

describe("a chat's own copy of its project", () => {
  it("starts from the last commit, becomes the chat's folder, and merges back", () => {
    const started = startOwnCopy(session, repo);
    expect(started.ok).toBe(true);
    const folder = ownCopyFolder(session)!;
    expect(folder).not.toBe(repo);
    expect(readFileSync(join(folder, "app.ts"), "utf8")).toBe("one\ntwo\nthree\n");

    writeFileSync(join(folder, "app.ts"), "one\ntwo\nthree\nfour\n");
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("one\ntwo\nthree\n");

    const merged = mergeOwnCopy(session);
    expect(merged).toMatchObject({ merged: true, files: 1 });
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("one\ntwo\nthree\nfour\n");
    expect(ownCopyOf(session)).toBeNull();
    expect(ownCopyFolder(session)).toBeNull();
  });

  it("tells the chat's agent where it works now", () => {
    startOwnCopy(session, repo);
    const copy = ownCopyOf(session)!;
    const block = otherAgentsSection(session);
    expect(block).toContain(`You work in your own copy of this project: ${copy.path.replace(/\\/g, "/")} (branch ${copy.branch})`);
    expect(block).toContain("when the user merges this copy back");
  });

  it("is refused for a chat that already changed files in the shared folder", () => {
    recordClaims({ sessionId: session, opId: "op", paths: [join(repo, "app.ts")], source: "written" });
    const started = startOwnCopy(session, repo);
    expect(started).toMatchObject({ ok: false });
    expect((started as { error: string }).error).toContain("already changed 1 file(s) in the shared folder (app.ts)");
    expect(ownCopyOf(session)).toBeNull();
  });

  it("does not merge over another chat's uncommitted work, and keeps the copy", () => {
    startOwnCopy(session, repo);
    const folder = ownCopyFolder(session)!;
    writeFileSync(join(folder, "new.ts"), "mine\n");
    writeFileSync(join(repo, "app.ts"), "the other chat is mid-edit\n");

    const merged = mergeOwnCopy(session);
    expect(merged.merged).toBe(false);
    expect(merged.error).toContain("uncommitted changes on main");
    expect(existsSync(join(folder, "new.ts"))).toBe(true);
    expect(ownCopyOf(session)).not.toBeNull();
  });

  it("does not merge into a conflict, and keeps the copy for the agent to resolve", () => {
    startOwnCopy(session, repo);
    const folder = ownCopyFolder(session)!;
    writeFileSync(join(folder, "app.ts"), "ONE\ntwo\nthree\n");
    commit(repo, "app.ts", "uno\ntwo\nthree\n", "main changes the same line");

    const merged = mergeOwnCopy(session);
    expect(merged.merged).toBe(false);
    expect(merged.error).toContain("conflicts with what is now on main");
    expect(readFileSync(join(folder, "app.ts"), "utf8")).toBe("ONE\ntwo\nthree\n");
    expect(ownCopyOf(session)).not.toBeNull();
  });

  it("leaving keeps the branch when it has unmerged work", () => {
    startOwnCopy(session, repo);
    const copy = ownCopyOf(session)!;
    writeFileSync(join(ownCopyFolder(session)!, "wip.ts"), "half done\n");
    expect(leaveOwnCopy(session)).toEqual({ left: true, branchKept: copy.branch });
    expect(existsSync(copy.path)).toBe(false);
    expect(g(repo, "branch", "--list", copy.branch)).toContain(copy.branch);
    expect(g(repo, "show", `${copy.branch}:wip.ts`)).toBe("half done");
  });

  it("lets the chat write in its copy and fences it off the parent repo, until the copy ends", () => {
    const calls: string[] = [];
    const security = {
      addAllowedPath: (p: string, s?: string) => { calls.push(`allow ${s} ${p}`); },
      removeAllowedPath: (p: string, s?: string) => { calls.push(`disallow ${s} ${p}`); },
      fenceToWorktree: (s: string) => { calls.push(`fence ${s}`); },
      releaseFence: (s: string) => { calls.push(`unfence ${s}`); },
    };
    anchorOwnCopy(security, session);
    expect(calls).toEqual([]);
    startOwnCopy(session, repo);
    const path = ownCopyOf(session)!.path;
    anchorOwnCopy(security, session);
    anchorOwnCopy(security, session);
    expect(calls).toEqual([`allow ${session} ${path}`, `fence ${session}`]);
    leaveOwnCopy(session);
    anchorOwnCopy(security, session);
    expect(calls.slice(2)).toEqual([`disallow ${session} ${path}`, `unfence ${session}`]);
  });
});
