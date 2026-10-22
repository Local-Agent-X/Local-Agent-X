import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityLayer } from "../security/layer/layer-core.js";
import { sessionWorkRootOf } from "../workspace/paths.js";
import { AgentWorkspaceError, planWorkDir, provisionAgentWorkspace, releaseAgentWorkspace } from "./agent-workspace.js";
import { cleanupWorktree } from "./worktree.js";

// Pin a confined sandbox so the delegated-shell gate's OS-containment half is
// deterministic on any host; the worktree half is what these tests exercise.
const sandbox = vi.hoisted(() => ({ status: {} as Record<string, unknown> }));
vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSandboxStatus: () => sandbox.status };
});
beforeEach(() => {
  sandbox.status = {
    selectedMode: "guarded", effectiveMode: "guarded", confined: true,
    unconfinedHostAcknowledged: false,
    delegatedShellAllowed: true, apiShellAllowed: true,
  };
});

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "lax-agent-ws-")));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const roots = {
  workspace: join(BASE, "lax", "workspace"),
  lax: join(BASE, "lax"),
  home: join(BASE, "home"),
};
mkdirSync(roots.workspace, { recursive: true });
mkdirSync(join(roots.lax, "src"), { recursive: true });
mkdirSync(join(roots.home, ".ssh"), { recursive: true });

function gitRepo(dir: string): string {
  mkdirSync(join(dir, "app"), { recursive: true });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

describe("planWorkDir — what a task's folder becomes", () => {
  it("creates a new folder name under the workspace", () => {
    const plan = planWorkDir("apps/crm", roots);
    expect(plan).toEqual({ kind: "folder", path: join(roots.workspace, "apps", "crm") });
    expect(existsSync(join(roots.workspace, "apps", "crm"))).toBe(true);
  });

  it("isolates a git repo as a repo, keeping the subfolder the task named", () => {
    const repo = gitRepo(join(BASE, "user-repo"));
    expect(planWorkDir(repo, roots)).toEqual({ kind: "repo", repoRoot: repo, subdir: "" });
    expect(planWorkDir(join(repo, "app"), roots)).toEqual({ kind: "repo", repoRoot: repo, subdir: "app" });
  });

  it("uses a plain existing folder as the work root", () => {
    const dir = join(BASE, "plain");
    mkdirSync(dir);
    expect(planWorkDir(dir, roots)).toEqual({ kind: "folder", path: dir });
  });

  it("refuses roots, home, the whole workspace, LAX's source, secrets, and missing outside folders", () => {
    for (const bad of ["/", roots.home, "~", roots.workspace, join(roots.lax, "src"), join(roots.home, ".ssh"), join(BASE, "nope")]) {
      expect(() => planWorkDir(bad, roots), bad).toThrow(AgentWorkspaceError);
    }
  });
});

describe("provisionAgentWorkspace — a spawned agent can run commands where it was sent", () => {
  const bash = (sec: SecurityLayer, sessionId: string) =>
    sec.evaluate({ toolName: "bash", args: { command: "git status" }, sessionId, callContext: "delegated" });

  // Live failure: a release worker sent to another repo got no worktree (the
  // only kind made was of LAX's own checkout) and every command was denied.
  it("a git repo gets its own worktree, registered under the run's session", () => {
    const repo = gitRepo(join(BASE, "release-repo"));
    const sec = new SecurityLayer(roots.workspace, "common");
    const session = "agent-run-repo";
    expect(bash(sec, session).allowed).toBe(false);

    // The worktree lands under the shared system temp base, so a fixed id left
    // there by a killed run would block every later run's `git worktree add`.
    const agentId = `ws-test-repo-${randomBytes(4).toString("hex")}`;
    const ws = provisionAgentWorkspace({ agentId, runSessionId: session, security: sec, requiresWorktree: false, workDir: join(repo, "app") });
    try {
      expect(ws.worktree).not.toBeNull();
      expect(ws.workRoot).toBe(join(ws.worktree!.path, "app"));
      expect(sessionWorkRootOf(session)).toBe(ws.workRoot);
      expect(bash(sec, session).allowed).toBe(true);
    } finally {
      releaseAgentWorkspace(ws, sec, session);
      cleanupWorktree(agentId);
    }
    expect(sessionWorkRootOf(session)).toBeUndefined();
    expect(bash(sec, session).allowed).toBe(false);
  });

  it("a plain folder becomes the run's scoped work root", () => {
    const dir = join(BASE, "plain-run");
    mkdirSync(dir);
    const sec = new SecurityLayer(roots.workspace, "common");
    const ws = provisionAgentWorkspace({ agentId: "ws-test-folder", runSessionId: "agent-run-folder", security: sec, requiresWorktree: false, workDir: dir });
    expect(ws).toMatchObject({ worktree: null, workRoot: dir });
    expect(bash(sec, "agent-run-folder").allowed).toBe(true);
    releaseAgentWorkspace(ws, sec, "agent-run-folder");
  });

  it("no folder named: a scratch folder of the run's own, where bash runs; removed when left empty, kept when written to", () => {
    const sec = new SecurityLayer(roots.workspace, "common");
    const session = "agent-run-scratch";
    const ws = provisionAgentWorkspace({ agentId: "ws-test-scratch", runSessionId: session, security: sec, requiresWorktree: false, workspace: roots.workspace });
    expect(ws.workRoot).toBe(join(roots.workspace, "agents", "ws-test-scratch"));
    expect(existsSync(ws.workRoot!)).toBe(true);
    expect(sessionWorkRootOf(session)).toBe(realpathSync(ws.workRoot!));
    expect(ws.promptBlock).toContain("Your own folder for this run");
    expect(bash(sec, session).allowed).toBe(true);
    releaseAgentWorkspace(ws, sec, session);
    expect(existsSync(ws.workRoot!)).toBe(false);
    expect(bash(sec, session).allowed).toBe(false);

    const kept = provisionAgentWorkspace({ agentId: "ws-test-scratch-kept", runSessionId: "agent-run-scratch-kept", security: sec, requiresWorktree: false, workspace: roots.workspace });
    writeFileSync(join(kept.workRoot!, "notes.md"), "found it");
    releaseAgentWorkspace(kept, sec, "agent-run-scratch-kept");
    expect(existsSync(join(kept.workRoot!, "notes.md"))).toBe(true);
  });

  it("refuses a folder it can't isolate before the run starts", () => {
    const sec = new SecurityLayer(roots.workspace, "common");
    expect(() => provisionAgentWorkspace({ agentId: "ws-test-bad", runSessionId: "agent-run-bad", security: sec, requiresWorktree: false, workDir: "/" }))
      .toThrow(/filesystem root/);
  });
});
