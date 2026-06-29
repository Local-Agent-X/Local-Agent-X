import { describe, it, expect, beforeAll } from "vitest";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig, uploadsDir } from "../config.js";
import { resolveAgentPath, projectRoot } from "./paths.js";
import { isSensitivePath } from "../data-lineage-paths.js";

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
