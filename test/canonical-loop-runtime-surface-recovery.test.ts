import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  dispatcherOptions: null as Record<string, unknown> | null,
  cleanup: null as (() => void) | null,
  broadcasts: [] as Array<{ sessionId: string; event: unknown }>,
  tools: new Map<string, ToolDefinition>(),
  entryFingerprints: new Map<string, string>(),
}));

vi.mock("../src/tools/registry.js", () => ({
  implementationFingerprintFor: (tool: ToolDefinition) => `implementation:${tool.name}`,
  unifiedRegistry: {
    get: (name: string) => mocks.tools.get(name),
    getEntry: (name: string) => {
      const tool = mocks.tools.get(name);
      const implementationFingerprint = mocks.entryFingerprints.get(name);
      return tool && implementationFingerprint ? { tool, implementationFingerprint } : undefined;
    },
  },
}));

vi.mock("../src/security/index.js", () => ({
  SecurityLayer: class {
    runtimePolicyFingerprint() { return "f".repeat(64); }
    restoreAllowedPaths() {}
    runtimeIdentity() {
      return {
        workspace: "C:\\workspace",
        fileAccessMode: "workspace",
        inlineEvalPolicy: "refuse",
        allowedPaths: [],
      };
    }
  },
}));

vi.mock("../src/canonical-loop/chat-tool-dispatcher.js", () => ({
  makeChatToolDispatcher: (options: Record<string, unknown>) => {
    mocks.dispatcherOptions = options;
    return { dispatch: vi.fn(), dispatchBatch: vi.fn() };
  },
}));

vi.mock("../src/canonical-loop/runtime.js", () => ({
  registerRuntimeCleanupForOp: (_opId: string, cleanup: () => void) => { mocks.cleanup = cleanup; },
  registerToolDispatcherForOp: vi.fn(),
  registerToolsForOp: vi.fn(),
}));

vi.mock("../src/ops/session-bridge.js", () => ({
  broadcastToSession: (sessionId: string, event: unknown) => mocks.broadcasts.push({ sessionId, event }),
}));

import { publishSignal } from "../src/canonical-loop/signals.js";
import {
  persistRuntimeSurface,
  rehydrateAgentRuntimeSurface,
  toolFingerprint,
} from "../src/canonical-loop/agent-runner/runtime-surface.js";
import { verifyDelegatedRuntimeIntegrity, sealDelegatedRuntime } from "../src/canonical-loop/runtime-integrity.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import { sessionWorkRootOf } from "../src/workspace/paths.js";
import type { DelegatedRuntimeSurface, Op } from "../src/ops/types.js";

let dataDir: string;
let workRoot: string;
let priorDataDir: string | undefined;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() { return { content: "ok" }; },
  };
}

function recoveredOp(surface: DelegatedRuntimeSurface): Op {
  const op = {
    id: "op_runtime_surface_recovery",
    type: "freeform",
    task: "recover exact surface",
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [1] },
    ownerId: "local-user",
    visibility: "private",
    status: "queued",
    createdAt: new Date().toISOString(),
    attemptCount: 1,
    model: "exact-model",
    canonical: { state: "queued", flagValue: true, sessionId: "session-recovered" },
    contextPack: {},
  } as Op;
  op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
    kind: "delegated-op",
    adapter: "provider-exact",
    provider: "codex",
    credentialProvider: "codex",
    authSource: "oauth",
    model: "exact-model",
    runtime: "codex",
    target: { kind: "provider-registry", endpointFingerprint: "a".repeat(64) },
    sessionId: "session-recovered",
    surface,
  });
  return op;
}

beforeEach(() => {
  priorDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "runtime-surface-"));
  workRoot = mkdtempSync(join(tmpdir(), "runtime-workroot-"));
  process.env.LAX_DATA_DIR = dataDir;
  mocks.tools.clear();
  mocks.entryFingerprints.clear();
  mocks.broadcasts.length = 0;
  mocks.dispatcherOptions = null;
  mocks.cleanup = null;
});

afterEach(() => {
  mocks.cleanup?.();
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

describe("recovered delegated runtime surface", () => {
  it("rejects restart when plugin or MCP executable provenance changes without persisting source content", () => {
    const action = tool("plugin_action");
    mocks.tools.set(action.name, action);
    mocks.entryFingerprints.set(action.name, "a".repeat(64));
    const surface: DelegatedRuntimeSurface = {
      kind: "agent-runner",
      systemPrompt: "resume exactly",
      tools: [{ name: action.name, fingerprint: toolFingerprint(action) }],
      security: {
        workspace: "C:\\workspace",
        fileAccessMode: "workspace",
        inlineEvalPolicy: "refuse",
        allowedPaths: [],
        configFingerprint: "f".repeat(64),
      },
      threatEngine: false,
      rbac: false,
      callContext: "delegated",
    };
    const op = recoveredOp(surface);
    const persisted = JSON.stringify(op.runtimeDescriptor);
    expect(persisted).not.toContain("plugin executable source");

    mocks.entryFingerprints.set(action.name, "b".repeat(64));
    expect(() => rehydrateAgentRuntimeSurface(op, surface)).toThrow("tool_identity_changed");
  });

  it("reseals tool augmentation, routes progress, bridges cancel, and cleans the work root", () => {
    const read = tool("read");
    const write = tool("write");
    mocks.tools.set(read.name, read);
    mocks.tools.set(write.name, write);
    const surface: DelegatedRuntimeSurface = {
      kind: "agent-runner",
      systemPrompt: "resume exactly",
      tools: [{ name: read.name, fingerprint: toolFingerprint(read) }],
      security: {
        workspace: "C:\\workspace",
        fileAccessMode: "workspace",
        inlineEvalPolicy: "refuse",
        allowedPaths: [],
        sessionWorkRoot: workRoot,
        configFingerprint: "f".repeat(64),
      },
      threatEngine: false,
      rbac: false,
      callContext: "delegated",
    };
    const op = recoveredOp(surface);
    writeOp(op);

    expect(rehydrateAgentRuntimeSurface(op, surface)).toBe("resume exactly");
    expect(sessionWorkRootOf("session-recovered")).toBeTruthy();
    const options = mocks.dispatcherOptions as {
      signal: AbortSignal;
      onEvent: (event: unknown) => void;
      onToolsAugmented: (tools: ToolDefinition[]) => void;
    };
    options.onEvent({ type: "agent_progress", text: "still working" });
    expect(mocks.broadcasts).toEqual([{
      sessionId: "session-recovered",
      event: { type: "agent_progress", text: "still working" },
    }]);

    options.onToolsAugmented([read, write]);
    const persisted = readOp(op.id)!;
    expect(() => verifyDelegatedRuntimeIntegrity(persisted)).not.toThrow();
    expect(persisted.runtimeDescriptor?.kind === "delegated-op"
      && persisted.runtimeDescriptor.adapter === "provider-exact"
      && persisted.runtimeDescriptor.surface?.tools.map(entry => entry.name))
      .toEqual(["read", "write"]);

    publishSignal({
      kind: "cancel",
      opId: op.id,
      actor: "user",
      ts: new Date().toISOString(),
    });
    expect(options.signal.aborted).toBe(true);
    mocks.cleanup?.();
    mocks.cleanup = null;
    expect(sessionWorkRootOf("session-recovered")).toBeUndefined();
  });

  it("keeps the prior signed tool surface when resealing cannot verify integrity", () => {
    const read = tool("read");
    const write = tool("write");
    mocks.tools.set(read.name, read);
    const surface: DelegatedRuntimeSurface = {
      kind: "agent-runner",
      systemPrompt: "resume exactly",
      tools: [{ name: read.name, fingerprint: toolFingerprint(read) }],
      security: {
        workspace: "C:\\workspace",
        fileAccessMode: "workspace",
        inlineEvalPolicy: "refuse",
        allowedPaths: [],
        configFingerprint: "f".repeat(64),
      },
      threatEngine: false,
      rbac: false,
      callContext: "delegated",
    };
    const op = recoveredOp(surface);
    writeOp(op);
    const tampered = readOp(op.id)!;
    if (tampered.runtimeDescriptor?.kind === "delegated-op" && tampered.runtimeDescriptor.adapter === "provider-exact") {
      tampered.runtimeDescriptor.integrity.mac = "0".repeat(64);
    }
    writeOp(tampered);

    expect(() => persistRuntimeSurface(op, current => ({
      ...current,
      tools: [
        ...current.tools,
        { name: write.name, fingerprint: toolFingerprint(write) },
      ],
    }))).toThrow("integrity check failed");
    const after = readOp(op.id)!;
    expect(after.runtimeDescriptor?.kind === "delegated-op"
      && after.runtimeDescriptor.adapter === "provider-exact"
      && after.runtimeDescriptor.surface?.tools.map(entry => entry.name))
      .toEqual(["read"]);
  });
});
