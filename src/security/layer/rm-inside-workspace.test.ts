// Confined file-access modes used to refuse every `rm -r`/`rm -f`, so a
// recursive delete inside the workspace was impossible without widening file
// access to the whole disk (op-outcomes restraint-wipe-build-cache, 0/3 under
// the confined rig). Now a recursive delete whose every target is provably
// strictly inside the workspace passes the shell policy and goes on to the
// irreversible floor's card; everything else is refused exactly as before.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmInsideWorkspaceVerdict, rmTargetsAllInsideWorkspace } from "./rm-inside-workspace.js";
import { evaluateShellCommand } from "./shell-policy.js";

let root: string;
let ws: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lax-rm-inside-")));
  ws = join(root, "workspace");
  mkdirSync(join(ws, "client-data", "build-cache", "chunks"), { recursive: true });
  writeFileSync(join(ws, "client-data", "build-cache", "chunks", "a.js"), "");
  mkdirSync(join(ws, "client-data", "originals"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const inside = (cmd: string) => rmTargetsAllInsideWorkspace(cmd, ws);

describe("rmTargetsAllInsideWorkspace — provably inside, or refused", () => {
  it("allows the plain spellings of a folder inside the workspace", () => {
    expect(inside("rm -rf client-data/build-cache")).toBe(true);
    expect(inside("rm -r client-data/build-cache")).toBe(true);
    expect(inside('rm -rf "client-data/build-cache"')).toBe(true);
    expect(inside("rm -r -f -- client-data/build-cache")).toBe(true);
    expect(inside("rm --recursive --force client-data/build-cache")).toBe(true);
    expect(inside(`rm -rf ${join(ws, "client-data", "build-cache")}`)).toBe(true);
    expect(inside("rm -rf client-data/build-cache/*")).toBe(true);
    expect(inside("rm -rf client-data/build-cache client-data/originals")).toBe(true);
  });

  // The file tools strip a leading workspace/, bash cannot: `rm -r workspace/x`
  // in a shell that already runs inside the workspace names a folder that does
  // not exist. Carding it asked the user to approve a no-op (EXP-24c), so it is
  // refused up front with the right spelling.
  it("refuses the workspace/ prefix up front, unless a real workspace/ child exists", () => {
    expect(rmInsideWorkspaceVerdict("rm -rf workspace/client-data/build-cache", ws)).toBe("workspace-prefix");
    expect(rmInsideWorkspaceVerdict("rm -r ./workspace/client-data/build-cache", ws)).toBe("workspace-prefix");
    expect(inside("rm -rf workspace/client-data/build-cache")).toBe(false);
    const r = evaluateShellCommand("rm -rf workspace/client-data/build-cache", undefined, ws, "workspace", process.platform);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("rm -r client-data/build-cache");
    mkdirSync(join(ws, "workspace", "nested"), { recursive: true });
    try {
      expect(rmInsideWorkspaceVerdict("rm -rf workspace/nested", ws)).toBe("inside");
    } finally {
      rmSync(join(ws, "workspace"), { recursive: true, force: true });
    }
  });

  it("refuses the workspace root, however it is spelled", () => {
    for (const cmd of ["rm -rf .", "rm -rf ./", "rm -rf *", "rm -rf ./*", `rm -rf ${ws}`, "rm -rf workspace"]) {
      expect(inside(cmd), cmd).toBe(false);
    }
  });

  it("refuses anything outside, or not provable", () => {
    for (const cmd of [
      `rm -rf ${join(root, "outside")}`,
      "rm -rf ../outside",
      "rm -rf client-data/../../outside",
      "rm -rf ~/Documents",
      "rm -rf $HOME/x",
      "rm -rf `pwd`/x",
      "rm -rf client-data/build-cache && rm -rf /",
      "rm -rf client-data/build-cache; echo hi",
      "rm -rf client-data/*/chunks",
      "rm -rf client-data/.*",
      "rm -rf --no-preserve-root client-data/build-cache",
      "rm -rf",
      "sudo rm -rf client-data/build-cache",
      "rm -rf client-data/build-cache > /dev/null",
    ]) {
      expect(inside(cmd), cmd).toBe(false);
    }
    expect(rmTargetsAllInsideWorkspace("rm -rf client-data/build-cache", undefined)).toBe(false);
  });

  it("refuses a symlink inside the workspace that points outside it", () => {
    const link = join(ws, "escape");
    try {
      symlinkSync(join(root, "outside"), link, "junction");
    } catch {
      return; // no symlink privilege on this host — the realpath branch is covered by the ../ cases
    }
    expect(inside("rm -rf escape")).toBe(false);
  });
});

describe("evaluateShellCommand — confined modes, with the workspace threaded", () => {
  it("lets a recursive delete inside the workspace through to the floor in workspace and common modes", () => {
    for (const mode of ["workspace", "common"] as const) {
      const r = evaluateShellCommand("rm -rf client-data/build-cache", undefined, ws, mode, process.platform);
      expect(r.allowed, mode).toBe(true);
    }
  });

  it("still refuses outside targets, the root, and an unthreaded mode or workspace", () => {
    expect(evaluateShellCommand(`rm -rf ${join(root, "outside")}`, undefined, ws, "workspace", process.platform).allowed).toBe(false);
    expect(evaluateShellCommand("rm -rf .", undefined, ws, "workspace", process.platform).allowed).toBe(false);
    expect(evaluateShellCommand("rm -rf client-data/build-cache", undefined, ws, undefined, process.platform).allowed).toBe(false);
    const r = evaluateShellCommand("rm -rf client-data/build-cache", undefined, undefined, "workspace", process.platform);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/delete_file/);
  });
});
