import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({ planMode: new Set<string>() }));

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "work-root-")));
const WORKSPACE = join(ROOT, "workspace");
mkdirSync(join(WORKSPACE, "apps", "proj"), { recursive: true });
mkdirSync(join(ROOT, "elsewhere", "project"), { recursive: true });
writeFileSync(join(WORKSPACE, "notes.md"), "x");

vi.mock("../../config.js", () => ({
  workspaceRoot: () => WORKSPACE,
  uploadsDir: () => join(ROOT, "uploads"),
}));
vi.mock("../../canonical-loop/public/plan-ledger.js", () => ({
  isEnforcedPlanMode: (sessionId: string) => fixture.planMode.has(sessionId),
}));

const { resolveSubmittedWorkRoot, WorkRootRefused } = await import("./work-root.js");
const { clearSessionWorkRoot, setSessionWorkRoot } = await import("../../workspace/paths.js");

afterEach(() => { fixture.planMode.clear(); });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("resolveSubmittedWorkRoot", () => {
  it("ignores work_root on the read-only lanes", () => {
    expect(resolveSubmittedWorkRoot("apps/proj", "interactive", "chat")).toBeUndefined();
    expect(resolveSubmittedWorkRoot(undefined, "background", "chat")).toBeUndefined();
  });

  it("defaults an omitted build root to the parent's own scope: its work root, else the workspace", () => {
    expect(resolveSubmittedWorkRoot(undefined, "build", "chat")).toBe(WORKSPACE);
    expect(resolveSubmittedWorkRoot("   ", "build", "chat")).toBe(WORKSPACE);
    const parentRoot = join(ROOT, "elsewhere", "project");
    setSessionWorkRoot("ide-default", parentRoot);
    try {
      expect(resolveSubmittedWorkRoot(undefined, "build", "ide-default")).toBe(parentRoot);
    } finally {
      clearSessionWorkRoot("ide-default");
    }
  });

  it("anchors a relative root at the workspace, with or without the workspace/ prefix", () => {
    const expected = join(WORKSPACE, "apps", "proj");
    expect(resolveSubmittedWorkRoot("apps/proj", "build", "chat")).toBe(expected);
    expect(resolveSubmittedWorkRoot("workspace/apps/proj", "build", "chat")).toBe(expected);
    expect(resolveSubmittedWorkRoot(expected, "build", undefined)).toBe(expected);
    expect(resolveSubmittedWorkRoot(".", "build", "chat")).toBe(WORKSPACE);
  });

  it("refuses a root that is not an existing directory", () => {
    expect(() => resolveSubmittedWorkRoot("apps/missing", "build", "chat")).toThrow(/not an existing directory/);
    expect(() => resolveSubmittedWorkRoot("notes.md", "build", "chat")).toThrow(/not an existing directory/);
  });

  it("refuses a root outside the workspace when the parent has no work root of its own", () => {
    expect(() => resolveSubmittedWorkRoot(join(ROOT, "elsewhere", "project"), "build", "chat"))
      .toThrow(/outside the workspace; a worker may only mutate where you could/);
    expect(() => resolveSubmittedWorkRoot("../elsewhere/project", "build", "chat")).toThrow(WorkRootRefused);
  });

  it("accepts a root inside the submitting session's own work root (an IDE / project session)", () => {
    const parentRoot = join(ROOT, "elsewhere", "project");
    setSessionWorkRoot("ide-session", parentRoot);
    try {
      // Relative paths for a work-rooted session anchor at ITS root, as every
      // file tool of that session does.
      expect(resolveSubmittedWorkRoot(".", "build", "ide-session")).toBe(parentRoot);
      expect(resolveSubmittedWorkRoot(parentRoot, "build", "ide-session")).toBe(parentRoot);
      expect(() => resolveSubmittedWorkRoot(ROOT, "build", "ide-session"))
        .toThrow(/outside the workspace and outside this session's work root/);
    } finally {
      clearSessionWorkRoot("ide-session");
    }
  });

  it("refuses a build submission while the parent session is in enforced plan mode", () => {
    fixture.planMode.add("chat");
    expect(() => resolveSubmittedWorkRoot("apps/proj", "build", "chat")).toThrow(/plan mode is on/);
    expect(resolveSubmittedWorkRoot("apps/proj", "build", "other-chat")).toBe(join(WORKSPACE, "apps", "proj"));
    expect(resolveSubmittedWorkRoot("apps/proj", "interactive", "chat")).toBeUndefined();
  });
});
