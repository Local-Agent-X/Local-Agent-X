/**
 * Tests for the protected-files guard that blocks the edit/write/delete_file
 * tools from modifying engine-core files.
 *
 * config/protected-files.json is HAND-MAINTAINED — nothing regenerates it (the
 * manifest generator emits a separate config/app-manifest.json and only lists
 * this file as metadata). When core modules were split from single files into
 * directories, the manifest silently rotted and whole trees (src/security/,
 * src/auth/, ...) stopped being protected. The drift guard below fails the
 * moment a protected path stops existing on disk, so it can't rot silently
 * again. The matcher tests lock the directory-subtree + segment-boundary
 * semantics.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProtectedFile, pathMatchesProtected } from "../src/config-loader.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "config/protected-files.json"), "utf-8"));
const entries: string[] = manifest.protected;

describe("protected-files manifest (drift guard)", () => {
  it("every protected path still exists on disk with the right kind", () => {
    const missing: string[] = [];
    for (const entry of entries) {
      const abs = join(REPO_ROOT, entry);
      const isDir = entry.endsWith("/");
      if (!existsSync(abs)) { missing.push(`${entry} (does not exist)`); continue; }
      const stat = statSync(abs);
      if (isDir && !stat.isDirectory()) missing.push(`${entry} (entry has trailing slash but is a file)`);
      if (!isDir && !stat.isFile()) missing.push(`${entry} (entry is a file path but is a directory — add trailing slash)`);
    }
    expect(missing, `stale protected-files.json entries:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every protected path has a human-readable reason", () => {
    const reasons = manifest.reason || {};
    const noReason = entries.filter(e => !reasons[e]);
    expect(noReason, `protected entries missing a reason: ${noReason.join(", ")}`).toEqual([]);
  });
});

describe("isProtectedFile — directory subtree protection", () => {
  it("protects a file inside a protected directory (repo-relative + absolute)", () => {
    expect(isProtectedFile("src/security/firewall.ts").protected).toBe(true);
    expect(isProtectedFile("C:/Users/x/Local Agent X/src/auth/token.ts").protected).toBe(true);
    expect(isProtectedFile("src/ari-kernel/grants.ts").protected).toBe(true);
  });

  it("protects exact core files regardless of leading path", () => {
    expect(isProtectedFile("src/index.ts").protected).toBe(true);
    expect(isProtectedFile("/abs/repo/src/types.ts").protected).toBe(true);
  });

  it("does NOT protect a sibling whose name only shares a guarded prefix", () => {
    // src/security-notes.ts is not inside src/security/.
    expect(isProtectedFile("src/security-notes.ts").protected).toBe(false);
  });

  it("does NOT protect ordinary source files", () => {
    expect(isProtectedFile("src/routes/memory.ts").protected).toBe(false);
    expect(isProtectedFile("public/js/chat.js").protected).toBe(false);
  });
});

describe("pathMatchesProtected — boundary semantics", () => {
  it("file entry matches on a segment boundary, not a bare suffix", () => {
    expect(pathMatchesProtected("x/src/auth.ts", "src/auth.ts")).toBe(true);
    expect(pathMatchesProtected("x/src/oauth.ts", "src/auth.ts")).toBe(false);
  });

  it("dir entry matches the subtree but not a prefixed sibling", () => {
    expect(pathMatchesProtected("a/b/src/security/x.ts", "src/security/")).toBe(true);
    expect(pathMatchesProtected("src/security/x.ts", "src/security/")).toBe(true);
    expect(pathMatchesProtected("a/b/src/security-notes.ts", "src/security/")).toBe(false);
  });
});
