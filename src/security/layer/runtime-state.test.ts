import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SecurityLayer } from "./layer-core.js";
import { restoreSecurityAllowedPaths, snapshotSecurityRuntime } from "./runtime-state.js";

let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "security-runtime-state-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SecurityLayer recovered runtime identity", () => {
  it("captures global and same-session paths without leaking another session", () => {
    const globalPath = resolve(dataDir, "global");
    const ownPath = resolve(dataDir, "own");
    const otherPath = resolve(dataDir, "other");
    const paths = new Map<string, Set<string>>([
      ["_global", new Set([globalPath])],
      ["session-own", new Set([ownPath])],
      ["session-other", new Set([otherPath])],
    ]);

    const identity = snapshotSecurityRuntime(dataDir, "common", "refuse", paths, "session-own");
    expect(identity.allowedPaths).toEqual([
      { sessionId: "_global", path: globalPath },
      { sessionId: "session-own", path: ownPath },
    ]);
    expect(JSON.stringify(identity)).not.toContain(otherPath);
  });

  it("fingerprints effective policy semantics rather than JSON formatting", () => {
    const semantic = {
      fileAccessMode: "common",
      inlineEvalPolicy: "allow",
      egressMode: "permissive",
      localServicePorts: [7001, 7002],
    };
    writeFileSync(join(dataDir, "security.json"), JSON.stringify(semantic, null, 4));
    const formatted = new SecurityLayer(dataDir, "common").runtimePolicyFingerprint();
    writeFileSync(join(dataDir, "security.json"), JSON.stringify({
      localServicePorts: [7001, 7002],
      egressMode: "permissive",
      inlineEvalPolicy: "allow",
      fileAccessMode: "common",
    }));
    const compact = new SecurityLayer(dataDir, "common").runtimePolicyFingerprint();
    expect(compact).toBe(formatted);
  });

  it("rejects relative or oversized restored authority", () => {
    const add = () => {};
    expect(() => restoreSecurityAllowedPaths(
      [{ sessionId: "session", path: "relative/path" }], () => {}, add,
    )).toThrow("invalid persisted allowed path");
    expect(() => restoreSecurityAllowedPaths(
      Array.from({ length: 1_001 }, (_, i) => ({ sessionId: "session", path: resolve(dataDir, String(i)) })),
      () => {}, add,
    )).toThrow("invalid persisted allowed paths");
  });
});
