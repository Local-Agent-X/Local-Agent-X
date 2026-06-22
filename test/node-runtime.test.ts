// node-runtime owns the app-owned macOS Node (provisioned into ~/.lax/runtime
// so the server runs on a Developer-ID-signed binary whose TCC grant survives
// brew upgrades). The actual download/extract is verified on-device; here we
// pin the resolved paths and the platform gate (so a test run never kicks off a
// real provision off macOS).

import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { MANAGED_NODE_DIR, MANAGED_NODE_BIN, ensureManagedNode } from "../desktop/src/node-runtime";

describe("managed node paths", () => {
  it("resolve under ~/.lax/runtime and match the PATH augment server-process prepends", () => {
    expect(MANAGED_NODE_DIR).toBe(join(homedir(), ".lax", "runtime"));
    expect(MANAGED_NODE_BIN).toBe(join(homedir(), ".lax", "runtime", "bin", "node"));
  });
});

describe("ensureManagedNode platform gate", () => {
  const orig = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: orig }));

  it("returns null without provisioning off macOS (Windows ships its own node)", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(ensureManagedNode()).toBeNull();
  });
});
