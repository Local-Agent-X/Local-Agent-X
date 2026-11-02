// A spawned agent's worktree gets its own dependencies: `npm ci` through the
// harness seam where a lockfile is, and a plain account to the agent when the
// install fails — never a link into the original checkout's node_modules.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentWorkspace } from "./agent-workspace.js";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; cwd: string; purpose: string }>,
  result: { ok: true, status: "ok", output: "" } as { ok: boolean; status: string; output: string },
}));
vi.mock("../tool-execution/harness-exec.js", () => ({
  executeHarnessCommand: async (req: { command: string; cwd: string; purpose: string }) => {
    harness.calls.push({ command: req.command, cwd: req.cwd, purpose: req.purpose });
    return harness.result;
  },
}));

import { installWorktreeDependencies } from "./worktree-deps.js";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "lax-wt-deps-")));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

function worktree(name: string, lockAt: Array<"root" | "sub">): AgentWorkspace {
  const path = join(BASE, name);
  mkdirSync(join(path, "app"), { recursive: true });
  if (lockAt.includes("root")) writeFileSync(join(path, "package-lock.json"), "{}");
  if (lockAt.includes("sub")) writeFileSync(join(path, "app", "package-lock.json"), "{}");
  return { worktree: { path, branch: `agent/${name}` }, workRoot: join(path, "app"), promptBlock: "" };
}

describe("installWorktreeDependencies", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.result = { ok: true, status: "ok", output: "added 120 packages" };
  });

  it("runs npm ci at the worktree root's lockfile through the harness seam", async () => {
    const ws = worktree("root-lock", ["root"]);
    const block = await installWorktreeDependencies(ws, "agent-run-1");
    expect(harness.calls).toEqual([{ command: "npm ci --no-audit --no-fund", cwd: ws.worktree!.path, purpose: "worktree-deps" }]);
    expect(block).toContain("installed this worktree's own node_modules");
  });

  it("prefers the work root's own lockfile (a project in a subfolder)", async () => {
    const ws = worktree("sub-lock", ["root", "sub"]);
    await installWorktreeDependencies(ws, "agent-run-2");
    expect(harness.calls[0].cwd).toBe(ws.workRoot);
  });

  it("does nothing without a lockfile, or without a worktree", async () => {
    expect(await installWorktreeDependencies(worktree("no-lock", []), "agent-run-3")).toBe("");
    expect(await installWorktreeDependencies({ worktree: null, workRoot: BASE, promptBlock: "" }, "agent-run-4")).toBe("");
    expect(harness.calls).toEqual([]);
  });

  it("tells the agent when the install failed, why, and not to link the original's node_modules", async () => {
    harness.result = { ok: false, status: "error", output: "npm ERR! code ENOTFOUND\nnpm ERR! network request failed" };
    const block = await installWorktreeDependencies(worktree("failed", ["root"]), "agent-run-5");
    expect(block).toContain("NOT installed");
    expect(block).toContain("ENOTFOUND");
    expect(block).toContain("Never link or copy the original repository's node_modules");
  });
});
