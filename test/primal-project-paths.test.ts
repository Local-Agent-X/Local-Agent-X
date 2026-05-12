import { describe, it, expect } from "vitest";
import { resolveProjectDir, PROJECTS_DIR } from "../src/primal-auto-build/project-paths.js";

describe("resolveProjectDir", () => {
  it("returns null for empty input", () => {
    expect(resolveProjectDir("")).toBeNull();
    expect(resolveProjectDir(undefined)).toBeNull();
    expect(resolveProjectDir(null)).toBeNull();
    expect(resolveProjectDir("   ")).toBeNull();
  });

  it("resolves a bare project name to workspace/apps/<name>", () => {
    const resolved = resolveProjectDir("mygroomtime");
    expect(resolved).not.toBeNull();
    expect(resolved!.replace(/\\/g, "/")).toMatch(/workspace\/apps\/mygroomtime$/);
    expect(resolved!).toBe(`${PROJECTS_DIR.replace(/\//g, "\\").replace(/\\/g, require("node:path").sep)}${require("node:path").sep}mygroomtime`);
  });

  it("returns absolute paths unchanged (windows)", () => {
    const win = "C:\\Users\\manri\\some-project";
    expect(resolveProjectDir(win)).toBe(win);
  });

  it("returns absolute paths unchanged (posix)", () => {
    const posix = "/tmp/some-project";
    expect(resolveProjectDir(posix)).toBe(posix);
  });

  it("resolves a relative path against cwd (legacy fallback)", () => {
    const r = resolveProjectDir("./some-relative");
    expect(r).not.toBeNull();
    // Not in workspace/apps — it had a separator, so falls through to cwd-resolve.
    expect(r!.replace(/\\/g, "/")).not.toMatch(/workspace\/apps/);
  });

  it("PROJECTS_DIR points at workspace/apps inside the LAX repo", () => {
    expect(PROJECTS_DIR.replace(/\\/g, "/")).toMatch(/local-agent-x\/workspace\/apps$/);
  });
});
