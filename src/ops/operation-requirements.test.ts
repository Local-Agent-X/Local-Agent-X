import { describe, expect, it } from "vitest";
import type {
  DelegatedRuntimeTarget,
  Op,
  PersistedTargetCapabilitySnapshot,
} from "./types.js";
import { runtimeTargetIdentity } from "./target-identity.js";
import { resolveOperationRequirements } from "./operation-requirements.js";
import { bootstrapProviderMatrix, getProvider } from "./provider-matrix.js";
import { PROVIDERS } from "../providers/registry.js";

const REMOTE_HASH = "1".repeat(64);
const LOCAL_HASH = "2".repeat(64);

describe("resolveOperationRequirements", () => {
  it("derives hard needs only from persisted surface, messages, and explicit facts", () => {
    const op = makeOp({
      capabilities: { needsJsonMode: true, needsStreaming: true },
      surfaceTools: ["read"],
      telemetry: { estimatedTokens: 200, toolSchemaEstimatedTokens: 40, loadedToolCount: 1 },
    });
    const messages = JSON.parse(JSON.stringify([
      { role: "assistant", content: { toolCalls: [{ id: "1", name: "read", arguments: "{}" }] } },
      { role: "user", content: { text: "inspect", images: [{ data: "x" }] } },
    ]));
    const resolved = resolveOperationRequirements(op, messages);

    expect(resolved.requirements).toMatchObject({
      needsTools: true,
      needsVision: true,
      needsJsonMode: true,
      needsStreaming: true,
    });
    expect(resolved.requirements.minimumContextTokens).toBeGreaterThan(1_264);
    expect(resolved.evidence).toEqual({
      actualToolUse: true,
      imageInput: true,
      persistedToolSurface: true,
      measuredContextFloor: true,
    });
  });

  it("makes a persisted rejection authoritative over contradictory certification", () => {
    const target = localTarget();
    const op = makeOp({
      provider: "local",
      model: "shared-model",
      target,
      snapshot: snapshot("local", "shared-model", target, {
        tools: "supported",
        toolsRejected: true,
        jsonMode: "supported",
        contextWindowTokens: 8_192,
      }),
    });
    const capabilities = resolveOperationRequirements(op, []).currentTarget?.capabilities;

    expect(capabilities).toMatchObject({
      tools: "unsupported",
      toolsRejected: true,
      jsonMode: "supported",
      contextWindowTokens: 8_192,
      locality: "local",
    });
    expect(resolveOperationRequirements(op, []).requirements.locality).toBe("local-only");
  });

  it("rejects capability evidence bound to another exact target with the same model name", () => {
    const local = localTarget();
    const remote: DelegatedRuntimeTarget = {
      kind: "provider-registry",
      endpointFingerprint: REMOTE_HASH,
    };
    const op = makeOp({
      provider: "openai",
      model: "shared-model",
      target: remote,
      snapshot: snapshot("local", "shared-model", local, {
        tools: "supported",
        vision: "supported",
        contextWindowTokens: 32_768,
      }),
    });

    expect(resolveOperationRequirements(op, []).currentTarget?.capabilities).toEqual({
      tools: "unknown",
      toolsRejected: false,
      vision: "unknown",
      streaming: "unknown",
      jsonMode: "unknown",
      localFiles: "unknown",
      contextWindowTokens: null,
      locality: "remote",
    });
  });

  it("rejects capability evidence from another model on the same endpoint", () => {
    const target: DelegatedRuntimeTarget = {
      kind: "provider-registry",
      endpointFingerprint: REMOTE_HASH,
    };
    const op = makeOp({
      provider: "openai",
      model: "model-b",
      target,
      snapshot: snapshot("openai", "model-a", target, { tools: "supported" }),
    });

    expect(resolveOperationRequirements(op, []).currentTarget?.capabilities.tools).toBe("unknown");
  });

  it("preserves immutable explicit pins and custom locality across restart", () => {
    const target: DelegatedRuntimeTarget = {
      kind: "custom-config",
      endpointFingerprint: REMOTE_HASH,
      locality: "local",
    };
    const original = makeOp({
      provider: "custom",
      model: "fallback-model",
      target,
      targetPin: { provider: "anthropic", model: "requested-model" },
      snapshot: snapshot("custom", "fallback-model", target),
    });
    const restarted = JSON.parse(JSON.stringify(original)) as Op;
    const resolved = resolveOperationRequirements(restarted, []);

    expect(resolved.pinnedTarget).toEqual({ provider: "anthropic", model: "requested-model" });
    expect(resolved.currentTarget).toMatchObject({ provider: "custom", model: "fallback-model" });
    expect(resolved.requirements.locality).toBe("local-only");
  });

  it("never reinterprets preferred_provider as a hard pin", () => {
    const op = makeOp({ preferredProvider: "openai" });
    expect(resolveOperationRequirements(op, []).pinnedTarget).toBeNull();
  });

  it("does not invent a context floor from incomplete persisted telemetry", () => {
    const op = makeOp({
      surfaceTools: ["read"],
      telemetry: { estimatedTokens: 200, toolSchemaEstimatedTokens: 40, loadedToolCount: 2 },
    });
    const resolved = resolveOperationRequirements(op, []);
    expect(resolved.requirements.minimumContextTokens).toBeUndefined();
    expect(resolved.evidence.measuredContextFloor).toBe(false);
  });

  it.each([
    ["toolsRejected", "false"],
    ["tools", "maybe"],
    ["vision", null],
    ["streaming", true],
    ["jsonMode", {}],
    ["localFiles", []],
    ["contextWindowTokens", 0],
    ["locality", "local-only"],
  ] as const)("fails the complete snapshot closed when %s is invalid", (field, invalid) => {
    const target: DelegatedRuntimeTarget = {
      kind: "provider-registry",
      endpointFingerprint: REMOTE_HASH,
    };
    const malformed = snapshot("openai", "gpt-4o", target, {
      tools: "supported",
      vision: "supported",
      streaming: "supported",
      jsonMode: "supported",
      localFiles: "supported",
      contextWindowTokens: 32_768,
      locality: "remote",
    }) as unknown as Record<string, unknown>;
    malformed[field] = invalid;

    expect(resolveOperationRequirements(makeOp({
      target,
      snapshot: malformed as unknown as PersistedTargetCapabilitySnapshot,
    }), []).currentTarget?.capabilities).toEqual(unknownRemoteCapabilities());
  });

  it("fails the complete snapshot closed when any mandatory field is missing", () => {
    const target: DelegatedRuntimeTarget = {
      kind: "provider-registry",
      endpointFingerprint: REMOTE_HASH,
    };
    const fields = [
      "toolsRejected",
      "tools",
      "vision",
      "streaming",
      "jsonMode",
      "localFiles",
      "contextWindowTokens",
      "locality",
    ] as const;

    for (const field of fields) {
      const malformed = snapshot("openai", "gpt-4o", target) as unknown as Record<string, unknown>;
      delete malformed[field];
      const capabilities = resolveOperationRequirements(makeOp({
        target,
        snapshot: malformed as unknown as PersistedTargetCapabilitySnapshot,
      }), []).currentTarget?.capabilities;
      expect(capabilities, field).toEqual(unknownRemoteCapabilities());
    }
  });

  it.each([
    null,
    {},
    { contextPack: null },
    { contextPack: { context: { recentTurns: "wrong" }, routing: [], capabilities: 5 } },
    { contextPack: { context: { recentTurns: [null, 4, { content: null }] } } },
    { runtimeDescriptor: { kind: "delegated-op", adapter: "provider-exact", target: [] } },
    makeMalformedOp({ surface: { tools: "wrong" } }),
    makeMalformedOp({ capabilitySnapshot: { tools: "supported", toolsRejected: "no" } }),
    makeMalformedOp({ capabilitySnapshot: { targetIdentity: "wrong", tools: "supported" } }),
  ])("never throws on malformed legacy facts %#", (candidate) => {
    expect(() => resolveOperationRequirements(candidate as Op, [null, 4] as never)).not.toThrow();
  });

  it("keeps capability truth out of the scheduler matrix", () => {
    bootstrapProviderMatrix();
    expect(PROVIDERS.local.capabilities.tools).toBe("target-dependent");
    expect(getProvider("localHttpOllama")).toEqual({
      id: "localHttpOllama",
      label: "Local model (Ollama)",
      maxConcurrent: 1,
      resourceLocks: ["gpu:0"],
    });
  });
});

function makeOp(input: {
  provider?: "openai" | "local" | "custom";
  model?: string;
  target?: DelegatedRuntimeTarget;
  snapshot?: PersistedTargetCapabilitySnapshot;
  targetPin?: Op["contextPack"]["routing"]["targetPin"];
  preferredProvider?: string;
  capabilities?: Op["contextPack"]["capabilities"];
  surfaceTools?: string[];
  telemetry?: { estimatedTokens: number; toolSchemaEstimatedTokens: number | null; loadedToolCount: number };
} = {}): Op {
  const provider = input.provider ?? "openai";
  const target = input.target ?? { kind: "provider-registry", endpointFingerprint: REMOTE_HASH };
  const tools = (input.surfaceTools ?? []).map((name) => ({ name, fingerprint: "3".repeat(64) }));
  return {
    id: "op-test",
    type: "agent_turn",
    task: "test",
    contextPack: {
      task: { description: "test", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: input.capabilities ?? {},
      budget: { maxIterations: 1, maxTokens: 0, maxWallTimeMs: 1_000, maxSelfEditCalls: 0 },
      routing: {
        lane: "background",
        preferredProvider: input.preferredProvider,
        ...(input.targetPin ? { targetPin: input.targetPin } : {}),
      },
      ...(input.telemetry ? { promptTelemetry: telemetry(provider, input.model ?? "gpt-4o", input.telemetry) } : {}),
      secrets: { allowed: [] },
    },
    lane: "background",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] },
    runtimeDescriptor: {
      kind: "delegated-op",
      adapter: "provider-exact",
      provider,
      credentialProvider: provider,
      authSource: "config",
      model: input.model ?? "gpt-4o",
      runtime: "openai-compat",
      target,
      ...(input.snapshot ? { capabilitySnapshot: input.snapshot } : {}),
      surface: {
        kind: "agent-runner",
        systemPrompt: "system",
        tools,
        security: {
          workspace: "C:/workspace",
          fileAccessMode: "workspace",
          inlineEvalPolicy: "refuse",
          allowedPaths: [],
          configFingerprint: "4".repeat(64),
        },
        threatEngine: false,
        rbac: false,
        callContext: "api",
      },
      integrity: { scheme: "hmac-sha256-v1", mac: "5".repeat(64) },
    },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: "2026-07-19T00:00:00.000Z",
    attemptCount: 0,
  } as Op;
}

function snapshot(
  provider: string,
  model: string,
  target: DelegatedRuntimeTarget,
  override: Partial<PersistedTargetCapabilitySnapshot> = {},
): PersistedTargetCapabilitySnapshot {
  return {
    targetIdentity: runtimeTargetIdentity({ provider, model, target }),
    tools: "unknown",
    toolsRejected: false,
    vision: "unknown",
    streaming: "unknown",
    jsonMode: "unknown",
    localFiles: "unknown",
    contextWindowTokens: null,
    locality: "unknown",
    ...override,
  };
}

function localTarget(): DelegatedRuntimeTarget {
  return {
    kind: "local-runtime",
    runtimeId: "lmstudio@127.0.0.1:1234",
    endpointFingerprint: LOCAL_HASH,
  };
}

function unknownRemoteCapabilities() {
  return {
    tools: "unknown",
    toolsRejected: false,
    vision: "unknown",
    streaming: "unknown",
    jsonMode: "unknown",
    localFiles: "unknown",
    contextWindowTokens: null,
    locality: "remote",
  };
}

function makeMalformedOp(descriptorPatch: Record<string, unknown>): unknown {
  const op = makeOp() as unknown as Record<string, unknown>;
  op.runtimeDescriptor = {
    ...(op.runtimeDescriptor as Record<string, unknown>),
    ...descriptorPatch,
  };
  return op;
}

function telemetry(
  provider: string,
  model: string,
  input: { estimatedTokens: number; toolSchemaEstimatedTokens: number | null; loadedToolCount: number },
) {
  return {
    version: 2 as const,
    recordedAt: "2026-07-19T00:00:00.000Z",
    profile: "full" as const,
    provider,
    model,
    characters: 0,
    utf8Bytes: 0,
    estimatedTokens: input.estimatedTokens,
    toolSchemaFormat: "openai-chat" as const,
    toolSchemaEstimatedTokens: input.toolSchemaEstimatedTokens,
    loadedToolCount: input.loadedToolCount,
    deferredToolCount: 0,
    historyMessageCount: 0,
    sections: [],
  };
}
