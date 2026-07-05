import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { resolveProjectDir, projectsDir } from "../src/auto-build/project-paths.js";
import { realpathDeep } from "../src/workspace/paths.js";
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
    // resolveProjectDir canonicalizes through realpathDeep (symlink-safe), which
    // projectsDir() does not, so compare against the realpath'd target — on
    // macOS /tmp is a symlink to /private/tmp and the raw join would differ.
    expect(resolved!).toBe(realpathDeep(join(projectsDir(), "petbook")));
  });

  it("resolves into the WORKSPACE ROOT, not the source repo (regression)", () => {
    // The bug: projectsDir() came from import.meta.url (the code location),
    // landing builds at <repo>/workspace/apps where the sandbox blocks writes.
    // It must track the configured workspace root instead. Asserted on the
    // distinctive configured suffix rather than an exact `.toBe(TEST_WS+…)`:
    // projectsDir() runs path.resolve, which on Windows prefixes the drive
    // (`/tmp/…` → `C:/tmp/…`) that the POSIX-literal TEST_WS lacks. The unique
    // "lax-test-projects" segment proves it tracks the CONFIGURED workspace, not
    // the repo, on every platform.
    expect(projectsDir().replace(/\\/g, "/")).toMatch(/\/lax-test-projects\/workspace\/apps$/);
  });

  // A Windows drive-absolute path is only meaningful on win32 — on POSIX there
  // is no drive to canonicalize, so realpathDeep would (correctly) re-root it
  // against cwd. Assert the semantics that matter (stays drive-absolute, is NOT
  // redirected into workspace/apps) on the only OS where the input is valid.
  it.skipIf(process.platform !== "win32")("keeps a Windows drive-absolute path absolute, not redirected to workspace/apps", () => {
    const win = "C:\\Users\\alice\\some-project";
    const r = resolveProjectDir(win)!;
    expect(r).toMatch(/^[a-zA-Z]:[\\/]/);
    expect(r.replace(/\\/g, "/")).not.toMatch(/workspace\/apps/);
  });

  it("canonicalizes an absolute POSIX path (realpath), not redirected to workspace/apps", () => {
    const posix = "/tmp/some-project";
    // Absolute → routed through realpathDeep (symlink-canonical), NOT treated as
    // a bare name (→ workspace/apps) or a relative path (→ cwd). On macOS /tmp
    // resolves to /private/tmp, so assert against realpathDeep, not the raw input.
    expect(resolveProjectDir(posix)).toBe(realpathDeep(posix));
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
