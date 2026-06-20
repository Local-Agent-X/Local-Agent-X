import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { resolveProjectDir, projectsDir } from "../src/primal-auto-build/project-paths.js";
import { setRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";

// Pin a known workspace root so the resolver is deterministic + never touches
// the real ~/.lax config (workspaceRoot() → getRuntimeConfig().workspace).
const TEST_WS = join("/tmp", "lax-test-projects", "workspace");

describe("resolveProjectDir", () => {
  beforeAll(() => {
    setRuntimeConfig({ workspace: TEST_WS } as unknown as LAXConfig);
  });

  it("returns null for empty input", () => {
    expect(resolveProjectDir("")).toBeNull();
    expect(resolveProjectDir(undefined)).toBeNull();
    expect(resolveProjectDir(null)).toBeNull();
    expect(resolveProjectDir("   ")).toBeNull();
  });

  it("resolves a bare project name to <workspace-root>/apps/<name>", () => {
    const resolved = resolveProjectDir("petbook");
    expect(resolved).not.toBeNull();
    expect(resolved!.replace(/\\/g, "/")).toMatch(/workspace\/apps\/petbook$/);
    expect(resolved!).toBe(join(projectsDir(), "petbook"));
  });

  it("resolves into the WORKSPACE ROOT, not the source repo (regression)", () => {
    // The bug: projectsDir() came from import.meta.url (the code location),
    // landing builds at <repo>/workspace/apps where the sandbox blocks writes.
    // It must track the configured workspace root instead.
    expect(projectsDir().replace(/\\/g, "/")).toBe(`${TEST_WS.replace(/\\/g, "/")}/apps`);
  });

  it("returns absolute paths unchanged (windows)", () => {
    const win = "C:\\Users\\alice\\some-project";
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

  it("projectsDir() ends at workspace/apps", () => {
    expect(projectsDir().replace(/\\/g, "/")).toMatch(/\/workspace\/apps$/);
  });
});
