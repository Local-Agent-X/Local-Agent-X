import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { isProtectedFile, pathMatchesProtected } from "./config-loader.js";

// The engine self-protection list (config/protected-files.json) names the
// platform's OWN core files by repo-relative path — "src/index.ts",
// "src/types.ts", "src/security/", etc. The class bug these tests pin: those
// entries were matched by bare path-SUFFIX, so a model editing an unrelated
// user project that happens to use the same (very common) filenames got
// falsely blocked. Protection must be anchored to the platform install root:
// LAX's own files stay locked; every other project is free.

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("isProtectedFile — anchored to the platform root", () => {
  it("protects the platform's OWN engine files (relative and absolute forms)", () => {
    expect(isProtectedFile("src/index.ts").protected).toBe(true);
    expect(isProtectedFile(join(REPO_ROOT, "src/index.ts")).protected).toBe(true);
    expect(isProtectedFile("src/types.ts").protected).toBe(true);
    expect(isProtectedFile(join(REPO_ROOT, "src/security/layer/file-access.ts")).protected).toBe(true);
    expect(isProtectedFile(join(REPO_ROOT, "src/canonical-loop/turn-loop/decide-outcome.ts")).protected).toBe(true);
  });

  it("does NOT protect an identically-named file in a DIFFERENT project", () => {
    for (const p of [
      "/Users/someone/my-app/src/index.ts",
      "/Users/someone/my-app/src/types.ts",
      "/Users/someone/my-app/src/config.ts",
      "/Users/someone/my-app/src/security/guard.ts",
      "/Users/someone/my-app/src/auth/login.ts",
      "/tmp/other-project/src/canonical-loop/x.ts",
    ]) {
      expect(isProtectedFile(p).protected, p).toBe(false);
    }
  });

  it("surfaces the configured reason for a genuinely protected file", () => {
    const r = isProtectedFile("src/index.ts");
    expect(r.protected).toBe(true);
    expect(r.reason).toMatch(/bootstrap/i);
  });

  it("never protects empty or platform-root-escaping input", () => {
    expect(isProtectedFile("").protected).toBe(false);
    expect(isProtectedFile(join(REPO_ROOT, "..", "sibling", "src", "index.ts")).protected).toBe(false);
  });
});

describe("pathMatchesProtected — segment-anchored matching on a repo-relative path", () => {
  it("matches a file entry exactly, not a loose suffix of a sibling name", () => {
    expect(pathMatchesProtected("src/index.ts", "src/index.ts")).toBe(true);
    expect(pathMatchesProtected("src/security-notes.ts", "src/security/")).toBe(false);
    expect(pathMatchesProtected("src/auth.ts", "src/auth/")).toBe(false); // a file is not the dir
  });

  it("matches a directory entry across its whole subtree", () => {
    expect(pathMatchesProtected("src/security/layer/file-access.ts", "src/security/")).toBe(true);
    expect(pathMatchesProtected("src/canonical-loop/turn-loop/x.ts", "src/canonical-loop/")).toBe(true);
  });
});
