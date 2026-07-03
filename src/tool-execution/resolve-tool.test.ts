/**
 * resolvePhase session-state injection — the seam that anchors a work-rooted
 * session's tools to its project.
 *
 * Regression (Jul 2 2026 food-truck-tracker run): the work-root registry, the
 * resolver, and the security-gate parity all existed and were unit-green, but
 * SESSION_SCOPED_TOOLS didn't include the file tools, so the executor never
 * stamped _sessionId into their args — sessionIdOf() returned undefined and
 * the registry was dead code in live runs. The chunk worker's relative read
 * resolved to the workspace parent and only recovered because the model
 * retried with an absolute path. This suite drives the REAL dispatch phase
 * and asserts the full seam: dispatch → arg stamp → resolver anchor.
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { resolvePhase } from "./resolve-tool.js";
import { createContext } from "./context.js";
import type { SecurityLayer } from "../security/index.js";
import { resolveAgentPath, sessionIdOf, setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
import { searchBase } from "../tools/glob-tool.js";
import { searchRoot } from "../tools/grep-tool.js";

const SESSION = "agent-seam-test-1";
// Pure path math — nothing touches disk, so the root doesn't need to exist.
const WORK_ROOT = resolve(process.cwd(), "seam-test-project");

afterEach(() => clearSessionWorkRoot(SESSION));

async function dispatch(name: string, args: Record<string, unknown>) {
  const ctx = createContext({
    tc: { id: "t1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId: SESSION,
  });
  const outcome = await resolvePhase(ctx);
  expect(outcome.kind).toBe("continue");
  return ctx;
}

describe("work-rooted session tool anchoring (dispatch → resolver seam)", () => {
  it("read gets _sessionId stamped and its relative path anchors to the work root", async () => {
    setSessionWorkRoot(SESSION, WORK_ROOT);
    const ctx = await dispatch("read", { path: "spec/plan.md" });
    expect(ctx.args._sessionId).toBe(SESSION);
    expect(resolveAgentPath(String(ctx.args.path), sessionIdOf(ctx.args)))
      .toBe(resolve(WORK_ROOT, "spec/plan.md"));
  });

  it("every path-taking file tool is session-stamped", async () => {
    setSessionWorkRoot(SESSION, WORK_ROOT);
    for (const name of ["write", "edit", "multi_edit", "edit_lines", "delete_file", "glob", "grep"]) {
      const ctx = await dispatch(name, { path: "x.txt" });
      expect(ctx.args._sessionId, name).toBe(SESSION);
    }
  });

  it("bash defaults its cwd to the session work root", async () => {
    setSessionWorkRoot(SESSION, WORK_ROOT);
    const ctx = await dispatch("bash", { command: "npm test" });
    expect(ctx.args._cwd).toBe(WORK_ROOT);
  });

  it("a session without a work root is unchanged — no bash cwd, default anchor", async () => {
    const bashCtx = await dispatch("bash", { command: "ls" });
    expect(bashCtx.args._cwd).toBeUndefined();
    const readCtx = await dispatch("read", { path: "notes.txt" });
    expect(resolveAgentPath(String(readCtx.args.path), sessionIdOf(readCtx.args)))
      .toBe(resolveAgentPath("notes.txt"));
  });

  it("glob/grep search bases anchor to the work root, explicit path and default", () => {
    setSessionWorkRoot(SESSION, WORK_ROOT);
    expect(searchBase("src", SESSION)).toBe(resolve(WORK_ROOT, "src"));
    expect(searchBase(undefined, SESSION)).toBe(WORK_ROOT);
    expect(searchRoot({ path: "src", _sessionId: SESSION })).toBe(resolve(WORK_ROOT, "src"));
    expect(searchRoot({ _sessionId: SESSION })).toBe(WORK_ROOT);
  });
});

// Drive resolvePhase without asserting a specific outcome — the anti-brick gate
// HALTs, so the work-root helper (which expects "continue") can't be reused.
async function resolveRaw(name: string, args: Record<string, unknown>, sessionId?: string) {
  const ctx = createContext({
    tc: { id: "p1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId,
  });
  const outcome = await resolvePhase(ctx);
  return { ctx, outcome };
}

describe("protected-file anti-brick gate keys on the edit family, not a name list (TD-5)", () => {
  // "src/tool-execution/" is a protected engine-core tree (config/protected-files.json),
  // resolved against PLATFORM_ROOT independent of cwd — so this asserts a real block.
  const PROTECTED = "src/tool-execution/resolve-tool.ts";

  it("blocks EVERY write-class file tool — including the multi_edit/edit_lines synonyms", async () => {
    // Pre-fix the gate was ["write","edit","delete_file"], so multi_edit and
    // edit_lines slipped through with identical blast radius. All five map to
    // ARI action "write" and must be blocked.
    for (const name of ["write", "edit", "multi_edit", "edit_lines", "delete_file"]) {
      const { ctx, outcome } = await resolveRaw(name, { path: PROTECTED });
      expect(outcome.kind, name).toBe("halt");
      expect(ctx.allowed, name).toBe(false);
      const msg = ctx.msgs.at(-1);
      expect(String(msg?.content), name).toContain("BLOCKED");
    }
  });

  it("does not block reads or edits to non-protected project files", async () => {
    const read = await resolveRaw("read", { path: PROTECTED });
    expect(read.outcome.kind).toBe("continue");
    const userFile = await resolveRaw("multi_edit", { path: "some/user/project/app.ts" });
    expect(userFile.outcome.kind).toBe("continue");
    expect(userFile.ctx.allowed).not.toBe(false);
  });
});

describe("deriveCallContext yields 'api' for the unattended MCP bridge (TD-6)", () => {
  it("an mcp- session runs as 'api', not an interactive 'local' session", async () => {
    const { ctx } = await resolveRaw("read", { path: "notes.txt" }, "mcp-bridge");
    expect(ctx.callContext).toBe("api");
  });

  it("known prefixes still map to their own contexts", async () => {
    expect((await resolveRaw("read", { path: "x" }, "agent-1")).ctx.callContext).toBe("delegated");
    expect((await resolveRaw("read", { path: "x" }, "cron-1")).ctx.callContext).toBe("cron");
    expect((await resolveRaw("read", { path: "x" }, "chat-1")).ctx.callContext).toBe("local");
  });
});
