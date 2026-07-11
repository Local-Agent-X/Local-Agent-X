import { describe, it, expect, beforeAll } from "vitest";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig, uploadsDir } from "../config.js";
import { resolveAgentPath, projectRoot, setSessionWorkRoot, clearSessionWorkRoot, sessionIdOf, realpathDeep } from "./paths.js";
import { isSensitivePath } from "../data-lineage/index.js";

// resolveAgentPath is the single source of truth for turning an agent's raw
// `path` argument into an absolute path. It must anchor RELATIVE paths to the
// project root (workspace parent), not process.cwd(), so the packaged app can
// relocate the workspace without agent paths silently resolving against the
// install directory.
describe("resolveAgentPath", () => {
  // A relocated workspace whose parent is NOT the test process cwd — the whole
  // point of the resolver. (resolve() normalizes to the host's drive/root.)
  const WS = resolve("/lax-test-home/Documents/Local Agent X/workspace");

  beforeAll(() => {
    setRuntimeConfig({ workspace: WS } as Partial<LAXConfig> as LAXConfig);
  });

  it("passes an absolute path through unchanged", () => {
    const abs = resolve("/some/abs/file.txt");
    expect(resolveAgentPath(abs)).toBe(abs);
  });

  it("anchors a bare relative path to the project root (workspace parent)", () => {
    expect(resolveAgentPath("notes.txt")).toBe(resolve(WS, "..", "notes.txt"));
  });

  it("lands a workspace-prefixed agent path inside the real workspace", () => {
    // "workspace/apps/<id>/index.html" is the agent's convention — anchoring to
    // the workspace PARENT makes it resolve into the workspace itself.
    expect(resolveAgentPath("workspace/apps/demo/index.html")).toBe(
      resolve(WS, "apps", "demo", "index.html"),
    );
  });

  it("does not resolve against process.cwd()", () => {
    // The resolved path must live under the relocated workspace's parent, never
    // under the test runner's cwd.
    const out = resolveAgentPath("apps/demo/index.html");
    expect(out.startsWith(resolve(WS, ".."))).toBe(true);
    expect(out.startsWith(process.cwd())).toBe(false);
  });

  // Attachments land in ~/.lax/uploads under a hashed name; the model is given a
  // "/uploads/<f>" reference. The resolver must map it to the uploads dir — NOT
  // a drive-root "/uploads" (which is what isAbsolute would otherwise produce on
  // Windows), or a file tool the model points at an attachment 404s.
  it("maps a /uploads reference to the uploads dir, not a drive root", () => {
    expect(resolveAgentPath("/uploads/55c07720aae37cf.pdf")).toBe(
      join(uploadsDir(), "55c07720aae37cf.pdf"),
    );
  });

  it("confines a /uploads reference to the flat uploads dir (no traversal escape)", () => {
    expect(resolveAgentPath("/uploads/../auth.json")).toBe(join(uploadsDir(), "auth.json"));
    expect(resolveAgentPath("/uploads/../../etc/passwd")).toBe(join(uploadsDir(), "passwd"));
  });

  // A leading "~" is the user's home — not a workspace-relative path. Without
  // expansion "~/.zshrc" was glued onto the project root (".../Local Agent
  // X/~/.zshrc") → File not found on the first try, only working after the model
  // re-sent an expanded path. Matches every other resolver (sql/email/egress/shell).
  it("expands a leading ~/ to the user's home directory", () => {
    expect(resolveAgentPath("~/.zshrc")).toBe(resolve(homedir(), ".zshrc"));
    expect(resolveAgentPath("~/Documents/notes.txt")).toBe(resolve(homedir(), "Documents", "notes.txt"));
  });

  it("expands a bare ~ to the home directory", () => {
    expect(resolveAgentPath("~")).toBe(homedir());
  });

  it("does not treat a ~ in the MIDDLE of a path as home (only a leading ~)", () => {
    // "backup~/x" is a real relative name, not a home reference.
    expect(resolveAgentPath("backup~/x")).toBe(resolve(WS, "..", "backup~/x"));
  });

  // The resolver is shared by the file tool AND the security gate, so expanding
  // ~ here means the gate now evaluates the REAL target: a ~-form credential path
  // must still be flagged sensitive (the gate ⊇ taint invariant holds post-expand).
  it("a ~-form credential path still resolves to a sensitive path", () => {
    expect(isSensitivePath(resolveAgentPath("~/.pgpass"))).toBe(true);
    expect(isSensitivePath(resolveAgentPath("~/.ssh/id_ecdsa"))).toBe(true);
  });

  // The shell-class default working directory (bash / process_start with no cwd)
  // is the project root — the workspace parent, the same anchor relative agent
  // paths use — so a relative command resolves in the project, not the server cwd.
  it("projectRoot is the workspace parent (the relative-path anchor)", () => {
    expect(projectRoot()).toBe(resolve(WS, ".."));
    expect(projectRoot()).toBe(resolveAgentPath("."));
  });
});

// Regression (2026-07-01 auto-build chunk 1): the chunk worker's task says
// "all paths are relative to your project dir" but write("app/layout.tsx")
// landed in <project root>/app/. A session with a registered work root must
// anchor its relative paths there — and revert on clear.
describe("session work-root anchor", () => {
  const WS = resolve("/lax-test-home/Documents/Local Agent X/workspace");
  const PROJ = resolve("/lax-test-home/Documents/Local Agent X/workspace/apps/food-trucks");

  beforeAll(() => {
    setRuntimeConfig({ workspace: WS } as Partial<LAXConfig> as LAXConfig);
  });

  it("anchors relative paths to the registered work root for that session", () => {
    setSessionWorkRoot("agent-run-1", PROJ);
    try {
      expect(resolveAgentPath("app/layout.tsx", "agent-run-1")).toBe(resolve(PROJ, "app", "layout.tsx"));
      // Other sessions are unaffected.
      expect(resolveAgentPath("app/layout.tsx", "agent-run-2")).toBe(resolve(WS, "..", "app", "layout.tsx"));
      // No session id → default anchor.
      expect(resolveAgentPath("app/layout.tsx")).toBe(resolve(WS, "..", "app", "layout.tsx"));
      // Absolute paths still pass through.
      const abs = resolve("/some/abs/file.txt");
      expect(resolveAgentPath(abs, "agent-run-1")).toBe(abs);
    } finally {
      clearSessionWorkRoot("agent-run-1");
    }
    expect(resolveAgentPath("app/layout.tsx", "agent-run-1")).toBe(resolve(WS, "..", "app", "layout.tsx"));
  });

  it("sessionIdOf extracts the executor-injected id and rejects non-strings", () => {
    expect(sessionIdOf({ _sessionId: "agent-run-9" })).toBe("agent-run-9");
    expect(sessionIdOf({ _sessionId: "" })).toBeUndefined();
    expect(sessionIdOf({})).toBeUndefined();
    expect(sessionIdOf({ _sessionId: 42 })).toBeUndefined();
  });
});

// Regression (2026-07-02 path-identity class): the dev-box workspace is a
// junction, so one physical project has two spellings. The work-root registry
// must canonicalize at REGISTRATION — the chokepoint — so every resolver hit
// hands downstream keyers (stale-read guard, security gate) the junction-TARGET
// spelling regardless of which spelling the caller registered.
describe("work-root canonicalization through junctions", () => {
  const canJunction = (() => {
    const base = mkdtempSync(join(tmpdir(), "lax-wr-probe-"));
    try { symlinkSync(join(base, "x"), join(base, "link"), "junction"); return true; }
    catch { return false; }
    finally { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  })();

  it.skipIf(!canJunction)("a work root registered via a junction spelling anchors at the target spelling", () => {
    const realProj = mkdtempSync(join(tmpdir(), "lax-wr-real-"));
    const linkBase = mkdtempSync(join(tmpdir(), "lax-wr-link-"));
    const viaJunction = join(linkBase, "proj");
    symlinkSync(realProj, viaJunction, "junction");
    try {
      setSessionWorkRoot("agent-junc-1", viaJunction);
      const resolved = resolveAgentPath("app/page.tsx", "agent-junc-1");
      // realpathSync may normalize drive-letter case; compare canonically.
      expect(resolved.toLowerCase()).toBe(resolve(realpathDeep(realProj), "app", "page.tsx").toLowerCase());
      // The junction spelling must not leak into resolved paths.
      expect(resolved.toLowerCase()).not.toContain(viaJunction.toLowerCase());
    } finally {
      clearSessionWorkRoot("agent-junc-1");
      try { rmSync(viaJunction, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(realProj, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(linkBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
