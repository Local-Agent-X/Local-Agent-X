/**
 * Bridge envelope sanitization contract.
 *
 * The ari_* bridge tools let the MODEL supply args. A compromised model must
 * NOT be able to launder identity / capability / taint by forging
 * `_`-prefixed envelope fields (`_runId`, `_principalId`, `_capabilityGrantId`,
 * `_taintLabels`). buildToolCall must derive every trust-critical field from
 * TRUSTED runtime context (the runtime-stamped `_sessionId`), never from the
 * model-supplied `_`-fields.
 *
 * Companion check: in a restrictive session preset (read-only / high-security)
 * an ari_file / ari_http call is denied just like write / http_request — a
 * forged `_runId` does not let the call slip the session policy, because the
 * policy keys on the tool name and the bridge keys runId on the trusted
 * `_sessionId`.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ToolClass } from "@arikernel/core";
import { buildToolCall, type BridgeConfig } from "../src/tools/arikernel-bridge.js";
import {
  setSessionPolicy,
  clearSessionPolicy,
  checkSessionPolicy,
} from "../src/session/policy.js";
import { recordSensitiveRead, clearSessionTaint } from "../src/data-lineage/index.js";
import { join, resolve } from "node:path";
import { workspaceRoot } from "../src/config.js";

const cfg: BridgeConfig = {
  toolName: "ari_file",
  toolClass: "file" as ToolClass,
  description: "test bridge",
  defaultAction: "read",
  // executor is never invoked by buildToolCall (a pure function); a stub keeps
  // the config shape honest without running real I/O.
  executor: { execute: async () => ({ success: true, callId: "x", durationMs: 0 }) } as unknown as BridgeConfig["executor"],
};

describe("bridge envelope sanitization", () => {
  it("ignores a forged _capabilityGrantId — grantId is never read from model args", () => {
    const tc = buildToolCall(cfg, {
      action: "read",
      _sessionId: "chat-trusted-123",
      _capabilityGrantId: "forged-grant",
    });
    expect(tc.grantId).toBeUndefined();
  });

  it("ignores forged _taintLabels — model cannot self-clear or self-declare taint", () => {
    // Model tries to clear taint with [] and also tries to inject a label.
    const cleared = buildToolCall(cfg, { _sessionId: "s1", _taintLabels: [] });
    expect(cleared.taintLabels).toEqual([]);
    const forged = buildToolCall(cfg, {
      _sessionId: "s1",
      _taintLabels: ["trusted-looking" as unknown as never],
    });
    // Forged taint is dropped; runtime owns taint injection (Chunk 4).
    expect(forged.taintLabels).toEqual([]);
  });

  it("ignores a forged _principalId — principal is never model-controlled", () => {
    const tc = buildToolCall(cfg, { _sessionId: "s1", _principalId: "root" });
    expect(tc.principalId).toBe("lax");
    expect(tc.principalId).not.toBe("root");
  });

  it("derives runId from trusted _sessionId, not from a forged _runId", () => {
    const tc = buildToolCall(cfg, {
      _sessionId: "chat-trusted-456",
      _runId: "attacker-run",
    });
    expect(tc.runId).toBe("chat-trusted-456");
    expect(tc.runId).not.toBe("attacker-run");
  });

  it("falls back to a fresh id (never a model value) when no trusted session id is present", () => {
    const tc = buildToolCall(cfg, { _runId: "attacker-run" });
    expect(tc.runId).not.toBe("attacker-run");
    expect(tc.runId).toBeTruthy();
  });

  it("strips all _-fields from the parameters handed to the executor", () => {
    const tc = buildToolCall(cfg, {
      encoding: "utf-8",
      _sessionId: "s1",
      _runId: "x",
      _principalId: "y",
      _capabilityGrantId: "z",
      _taintLabels: [],
    });
    expect(tc.parameters.encoding).toBe("utf-8");
    expect(tc.parameters._sessionId).toBeUndefined();
    expect(tc.parameters._runId).toBeUndefined();
    expect(tc.parameters._principalId).toBeUndefined();
    expect(tc.parameters._capabilityGrantId).toBeUndefined();
    expect(tc.parameters._taintLabels).toBeUndefined();
  });
});

describe("bridge injects runtime session taint (Chunk 4 seam)", () => {
  const SID = "chat-tainted-bridge-1";
  afterEach(() => clearSessionTaint(SID));

  it("passes runtime session taint (not []) into the ToolCall when the session is tainted", () => {
    // Simulate a prior web read tainting this session (runtime-recorded, NOT
    // model-supplied). The bridge keys off the trusted _sessionId.
    recordSensitiveRead(SID, "web", "https://evil.example/page");
    const tc = buildToolCall(cfg, { path: "notes.txt", _sessionId: SID });
    expect(tc.taintLabels.length).toBeGreaterThan(0);
    // web → kernel "web" source; origin is the trusted runtime, never the model.
    expect(tc.taintLabels.map(l => l.source)).toContain("web");
    expect(tc.taintLabels.every(l => l.origin === "runtime")).toBe(true);
  });

  it("a sensitive-file read taints the bridge ToolCall so the kernel sees non-empty taint", () => {
    recordSensitiveRead(SID, "sensitive_file", "/Users/x/.aws/credentials");
    const tc = buildToolCall(cfg, { path: "notes.txt", _sessionId: SID });
    // sensitive_file maps onto a kernel untrusted-content source (rag), which
    // the kernel's taint rules recognize.
    expect(tc.taintLabels.map(l => l.source)).toContain("rag");
  });

  it("stays [] when the session has no taint and the model forges _taintLabels", () => {
    const tc = buildToolCall(cfg, {
      _sessionId: SID,
      _taintLabels: ["model-injected" as unknown as never],
    });
    expect(tc.taintLabels).toEqual([]);
  });
});

describe("session policy governs ari_* synonyms", () => {
  const SID = "chat-restrictive-1";
  afterEach(() => clearSessionPolicy(SID));

  it("blocks ari_file in a read-only session, just like write", () => {
    setSessionPolicy(SID, "read-only");
    expect(checkSessionPolicy(SID, "write")).toBeTruthy();
    expect(checkSessionPolicy(SID, "ari_file")).toBeTruthy();
  });

  it("blocks ari_http in a high-security session, just like http_request", () => {
    setSessionPolicy(SID, "high-security");
    expect(checkSessionPolicy(SID, "http_request")).toBeTruthy();
    expect(checkSessionPolicy(SID, "ari_http")).toBeTruthy();
  });

  it("a forged _runId on the bridge call cannot route around the trusted-session policy", () => {
    // The bridge derives runId from the trusted _sessionId; the kernel gate
    // keys session policy on that runId. Simulate: trusted session is
    // read-only, model forges a different _runId.
    setSessionPolicy(SID, "read-only");
    const tc = buildToolCall(cfg, { _sessionId: SID, _runId: "escape-hatch" });
    expect(tc.runId).toBe(SID);
    // Policy keyed on the trusted runId (== sessionId) still denies ari_file.
    expect(checkSessionPolicy(tc.runId, "ari_file")).toBeTruthy();
  });
});

// The file executor resolves a relative path against the server's cwd, which
// is the install folder; the gate it calls resolves the same path from the
// workspace. "package.json" was judged as <workspace>/package.json and written
// to <install>/package.json.
describe("ari_file hands the executor the path the gate judges", () => {
  const fileCfg: BridgeConfig = { ...cfg, toolName: "ari_file", toolClass: "file" as ToolClass, defaultAction: "read" };

  it("resolves a relative path from the workspace, not from the server's cwd", () => {
    const tc = buildToolCall(fileCfg, { action: "write", path: "package.json", content: "x", _sessionId: "s1" });
    expect(tc.parameters.path).toBe(join(workspaceRoot(), "package.json"));
    expect(tc.parameters.path).not.toBe(resolve("package.json"));
  });
});
