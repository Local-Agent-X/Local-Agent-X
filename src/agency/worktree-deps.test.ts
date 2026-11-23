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

import { dependenciesBehindLockfile, installIfBehindLockfile, installWorktreeDependencies } from "./worktree-deps.js";

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

// The checkout a worktree merges back into: a chunk that added a package
// installed it in its own worktree, and the merge brought back only the
// manifest and lockfile (label-check's Firebase chunk, 2026-11-22).
describe("dependenciesBehindLockfile / installIfBehindLockfile", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.result = { ok: true, status: "ok", output: "added 5 packages" };
  });

  function project(name: string, deps: Record<string, string>, locked: Record<string, string>, installed: Record<string, string>): string {
    const dir = join(BASE, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, devDependencies: { vitest: "^3.0.0" } }));
    const packages: Record<string, { version: string; optional?: boolean }> = { "node_modules/vitest": { version: "3.2.4" } };
    for (const [n, v] of Object.entries(locked)) packages[`node_modules/${n}`] = { version: v };
    packages["node_modules/@esbuild/linux-x64"] = { version: "0.25.0", optional: true };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    for (const [n, v] of Object.entries({ vitest: "3.2.4", ...installed })) {
      mkdirSync(join(dir, "node_modules", n), { recursive: true });
      writeFileSync(join(dir, "node_modules", n, "package.json"), JSON.stringify({ name: n, version: v }));
    }
    return dir;
  }

  it("names a package the lockfile has and node_modules lacks, and one at another version", () => {
    const dir = project("merged", { "expo": "^54.0.0", "@react-native-firebase/app": "^27.1.1" },
      { "expo": "54.0.1", "@react-native-firebase/app": "27.1.1" }, { "expo": "54.0.0" });
    expect(dependenciesBehindLockfile(dir)).toEqual(["expo", "@react-native-firebase/app"]);
  });

  it("is empty when every own dependency is installed at its locked version, whatever other platforms' packages the lockfile carries", () => {
    const dir = project("current", { "expo": "^54.0.0" }, { "expo": "54.0.1" }, { "expo": "54.0.1" });
    expect(dependenciesBehindLockfile(dir)).toEqual([]);
  });

  it("is empty without a lockfile", () => {
    const dir = join(BASE, "no-lockfile");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "^54.0.0" } }));
    expect(dependenciesBehindLockfile(dir)).toEqual([]);
  });

  it("runs npm ci through the harness only when something is behind", async () => {
    const current = project("current-2", { "expo": "^54.0.0" }, { "expo": "54.0.1" }, { "expo": "54.0.1" });
    expect(await installIfBehindLockfile(current, "op-1")).toEqual({ behind: [], ok: true });
    expect(harness.calls).toEqual([]);

    const behind = project("behind-2", { "firebase": "^12.19.0" }, { "firebase": "12.19.0" }, {});
    expect(await installIfBehindLockfile(behind, "op-2")).toEqual({ behind: ["firebase"], ok: true });
    expect(harness.calls).toEqual([{ command: "npm ci --no-audit --no-fund", cwd: behind, purpose: "base-deps" }]);
  });

  it("says why when the install fails", async () => {
    harness.result = { ok: false, status: "error", output: "npm ERR! code EBUSY\nnpm ERR! resource busy or locked" };
    const dir = project("busy", { "firebase": "^12.19.0" }, { "firebase": "12.19.0" }, {});
    const r = await installIfBehindLockfile(dir, "op-3");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("EBUSY");
  });
});
