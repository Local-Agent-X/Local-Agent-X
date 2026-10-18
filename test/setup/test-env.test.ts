// The checkout's workspace/ is per-machine user data no test may touch unless
// it opts in. test-env.ts gives every test file a temp workspace of its own;
// these pin that the default config resolves there, and that loading the
// config from the checkout never links or replaces the checkout's workspace/.

import { describe, it, expect } from "vitest";
import { lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadConfig, workspaceRoot } from "../../src/config.js";
import { resolveAgentPath } from "../../src/workspace/paths.js";
import { isEphemeralPath } from "../../src/workspace/lifecycle.js";
import { pathIsWithin } from "../../src/security/layer/path-within.js";

function checkoutWorkspace(): unknown {
  try {
    const stat = lstatSync(resolve("workspace"));
    return stat.isSymbolicLink() ? { kind: "link", target: readlinkSync(resolve("workspace")) } : { kind: stat.isDirectory() ? "directory" : "file" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}
// Taken before any test loads the config (workspaceRoot() does, lazily).
const checkoutWorkspaceAtStart = checkoutWorkspace();

describe("test files run in a workspace of their own", () => {
  it("the default workspace is a temp folder, not the checkout's", () => {
    const ws = workspaceRoot();
    expect(ws).toBe(resolve(process.env.LAX_WORKSPACE!));
    expect(ws).not.toBe(resolve("workspace"));
    expect(isEphemeralPath(ws)).toBe(true);
    // The file gate allows the workspace's parent, so that parent must not be
    // tmpdir itself, or every tmpdir fixture would read as inside the zone.
    expect(dirname(ws)).not.toBe(resolve(tmpdir()));
  });

  it("agent paths resolve into that workspace", () => {
    expect(pathIsWithin(workspaceRoot(), resolveAgentPath("workspace/notes/a.md"))).toBe(true);
    expect(pathIsWithin(workspaceRoot(), resolveAgentPath("apps/x/index.html"))).toBe(true);
  });

  it("loading the config leaves the checkout's workspace/ as it was", () => {
    loadConfig();
    expect(checkoutWorkspace()).toEqual(checkoutWorkspaceAtStart);
  });
});
