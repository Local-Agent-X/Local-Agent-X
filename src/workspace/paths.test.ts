import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig } from "../config.js";
import { resolveAgentPath } from "./paths.js";

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
});
