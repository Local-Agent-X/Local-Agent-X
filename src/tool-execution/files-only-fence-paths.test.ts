// A files-only fence (the auto-build skeptic's probe folder) bounds where file
// tools write; it is not where the run works. Anchored at the fence, the
// skeptic's reads of src/… opened .skeptic/src/… and failed (label-check,
// 2026-11-23). A real worktree fence still re-anchors a worker's paths.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityLayer } from "../security/index.js";
import { setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
import { dispatchOne } from "./dispatch-one.test-helper.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { readTool } from "../tools/read-write-tools.js";
import { globTool } from "../tools/glob-tool.js";

const SESSION = "agent-files-only-fence-test";
let dir: string;
let project: string;
const prevDir = process.env.LAX_DATA_DIR;
const prevKey = process.env.LAX_AUDIT_KEY;
beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lax-files-only-fence-")));
  project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "match.ts"), "export const rule = 'v1';\n");
  process.env.LAX_DATA_DIR = join(dir, "data");
  process.env.LAX_AUDIT_KEY = "test-files-only-fence-key-0123456789";
  await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
});
afterAll(() => {
  stopAriKernel();
  clearSessionWorkRoot(SESSION);
  if (prevDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDir;
  if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevKey;
  rmSync(dir, { recursive: true, force: true });
});

function securityFor(fence: Parameters<SecurityLayer["fenceToWorktree"]>[1]): SecurityLayer {
  const security = new SecurityLayer(join(dir, "workspace"), "common");
  security.addAllowedPath(project, SESSION);
  setSessionWorkRoot(SESSION, project);
  security.fenceToWorktree(SESSION, fence);
  return security;
}

describe("relative paths under a files-only fence", () => {
  it("read src/match.ts reads the project's file, not one inside the probe folder", async () => {
    const security = securityFor({ worktree: join(project, ".skeptic"), repoRoot: project, filesOnly: true });
    const result = await dispatchOne(
      { id: "r1", name: "read", args: { path: "src/match.ts" } },
      { toolMap: new Map([["read", readTool]]), security, sessionId: SESSION, callContext: "delegated" },
    );
    expect(result.status ?? "ok").toBe("ok");
    expect(result.content).toContain("export const rule = 'v1';");
  });
});

// A worker's search outside its worktree used to be swapped for the worktree
// root and reported "ok, 0 matches" from a folder it never named; a seal probe
// read that as "not refused" and stopped the build (label-check-sol, 2026-11-24).
describe("a search root under a worktree fence", () => {
  const glob = (path: string, security: SecurityLayer) => dispatchOne(
    { id: "g1", name: "glob", args: { pattern: "**/*.ts", path } },
    { toolMap: new Map([["glob", globTool]]), security, sessionId: SESSION, callContext: "delegated" },
  );

  it("outside the worktree and its checkout: refused, nothing searched", async () => {
    const worktree = join(dir, "wt");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "own.ts"), "x\n");
    const outside = join(dir, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const result = await glob(outside, securityFor({ worktree, repoRoot: project }));
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("nothing was searched there");
    expect(result.content).not.toContain("own.ts");
  });

  it("in the checkout the worktree was cut from: searches the same place in the worktree", async () => {
    const worktree = join(dir, "wt2");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "copy.ts"), "x\n");
    const result = await glob(join(project, "src"), securityFor({ worktree, repoRoot: project }));
    expect(result.status ?? "ok").toBe("ok");
    expect(result.content).toContain("copy.ts");
  });
});
