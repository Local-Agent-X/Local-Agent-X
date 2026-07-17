import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAN_CREATE_DIRECTORY_LINK } from "../../symlink-capabilities.test-helper.js";
import { SecurityLayer } from "./layer-core.js";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));

function makeLayer() {
  return new SecurityLayer(WORKSPACE, "common");
}


describe("delegated worktree gate — canonical classification + work-root provisioning", () => {
  const delegated = (sec: SecurityLayer, toolName: string, args: Record<string, unknown>, sessionId: string) =>
    sec.evaluate({ toolName, args, sessionId, callContext: "delegated" });

  // Regression (2026-07-01 auto-build chunk 1). Three failure modes of one
  // gate: (1) `startsWith(root + "/")` never matched Windows backslash
  // paths, so repo source classified as "user content" and the gate was a
  // no-op for delegated write/edit on Windows; (2) a junction/symlink
  // spelling of the workspace flipped the classification; (3) sanctioned
  // project workers had no way to satisfy the gate for bash at all.

  it("denies delegated write to repo source without isolation (sep-safe)", () => {
    const sec = makeLayer();
    const d = delegated(sec, "write", { path: join(WORKSPACE_ROOT, "src", "index.ts"), content: "x" }, "agent-src");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("worktree isolation");
  });

  it("allows delegated write to workspace content without isolation", () => {
    const sec = makeLayer();
    const d = delegated(sec, "write", { path: join(WORKSPACE, "apps", "proj", "index.html"), content: "x" }, "agent-ws");
    expect(d.allowed).toBe(true);
  });

  it("allows delegated delete_file of user-content without isolation", () => {
    const sec = makeLayer();
    const d = delegated(sec, "delete_file", { path: join(WORKSPACE, "apps", "proj", "old.html") }, "agent-del");
    expect(d.allowed).toBe(true);
  });

  it("still denies delegated delete_file of repo SOURCE without isolation", () => {
    const sec = makeLayer();
    const d = delegated(sec, "delete_file", { path: join(WORKSPACE_ROOT, "src", "index.ts") }, "agent-del-src");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("worktree isolation");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("classifies a symlink/junction spelling of the workspace consistently", () => {
    // Configured workspace is a LINK; the write path uses the TARGET
    // spelling. Same physical dir — must classify as user content.
    const realWs = join(WORKSPACE_ROOT, "actual-ws");
    mkdirSync(realWs, { recursive: true });
    const linkWs = join(WORKSPACE_ROOT, "ws-link");
    symlinkSync(realWs, linkWs, DIRECTORY_LINK_TYPE);
    const sec = new SecurityLayer(linkWs, "common");
    const d = delegated(sec, "write", { path: join(realWs, "apps", "p", "a.txt"), content: "x" }, "agent-j");
    expect(d.allowed).toBe(true);
  });

  it("delegated bash is denied without a registered work root", () => {
    const sec = makeLayer();
    const d = delegated(sec, "bash", { command: "npm test" }, "agent-nb");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("worktree isolation");
  });

  it("delegated bash is allowed once the run's work root is registered", () => {
    const sec = makeLayer();
    const root = join(WORKSPACE, "apps", "proj");
    sec.addAllowedPath(root, "agent-wb");
    try {
      const d = delegated(sec, "bash", { command: "npm test" }, "agent-wb");
      expect(d.allowed).toBe(true);
    } finally {
      sec.removeAllowedPath(root, "agent-wb");
    }
  });

  // isInAllowedPaths must match across a symlinked base: a worktree registered
  // under its /var spelling has to satisfy the allowed-path set for a target the
  // gate realpath'd to the /private/var form (the macOS WORKTREE_BASE case that
  // blocked every parallel-build chunk write). addAllowedPath stores both forms.
  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("honors a worktree registered under a SYMLINKED base for a realpath'd write target", () => {
    const realWt = join(WORKSPACE_ROOT, "sym-real-wt");
    mkdirSync(realWt, { recursive: true });
    const linkWt = join(WORKSPACE_ROOT, "sym-link-wt");
    symlinkSync(realWt, linkWt, DIRECTORY_LINK_TYPE);
    const sec = new SecurityLayer(WORKSPACE, "common");
    // Register the worktree via the SYMLINK spelling (the un-realpath'd form the
    // worktree creator hands us); the write target is spelled the same way but
    // the gate resolves it to realWt/… before checking containment.
    sec.addAllowedPath(linkWt, "agent-sym");
    const d = sec.evaluate({
      toolName: "write",
      args: { path: join(linkWt, "app", "layout.tsx"), content: "x" },
      sessionId: "agent-sym",
    });
    expect(d.allowed, d.reason).toBe(true);
  });
});
