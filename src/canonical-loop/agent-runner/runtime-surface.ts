import { createHash } from "node:crypto";
import { getRuntimeConfig } from "../../config.js";
import { getLaxDir } from "../../lax-data-dir.js";
import type { DelegatedRuntimeSurface, Op } from "../../ops/types.js";
import { readOp, withOpLock, writeOp } from "../../ops/op-store.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { RBACManager, type Role } from "../../rbac.js";
import { SecurityLayer } from "../../security/index.js";
import { ThreatEngine } from "../../threat/threat-engine.js";
import { loadToolPolicy, type ToolPolicy } from "../../tool-policy/index.js";
import { TOOL_POLICIES } from "../../tool-policy/tool-policies.data.js";
import { matchGlob } from "../../tool-policy/matchers.js";
import { implementationFingerprintFor, unifiedRegistry } from "../../tools/registry.js";
import type { ServerEvent, ToolDefinition } from "../../types.js";
import type { CallContext } from "../../tool-execution/context.js";
import { installSessionWorkRoot, sessionWorkRootOf } from "../../workspace/paths.js";
import { bridgeOpCancelToToolSignal, type ToolCancelBridge } from "../cancel-handler.js";
import { makeChatToolDispatcher } from "../chat-tool-dispatcher.js";
import { registerRuntimeCleanupForOp, registerToolDispatcherForOp, registerToolsForOp } from "../runtime.js";
import { sealDelegatedRuntime, verifyDelegatedRuntimeIntegrity } from "../runtime-integrity.js";
import type { CanonicalAgentOptions } from "./types.js";
import { RuntimeSurfaceMismatchError, runtimeSurfaceMismatch } from "./runtime-surface-error.js";

/** The slice of CanonicalAgentOptions the durable surface actually captures.
 *  Narrowed so non-chat callers (delegated ops) can build a surface without
 *  fabricating a full provider options object. */
export type AgentRuntimeSurfaceOptions = Pick<CanonicalAgentOptions,
  "systemPrompt" | "tools" | "security" | "toolPolicy" | "threatEngine" | "rbac" | "callerRole" | "callContext" | "runId">;

export function buildAgentRuntimeSurface(options: AgentRuntimeSurfaceOptions, sessionId: string): DelegatedRuntimeSurface {
  return {
    kind: "agent-runner",
    systemPrompt: options.systemPrompt,
    tools: options.tools.map(tool => ({ name: tool.name, fingerprint: toolFingerprint(tool) })),
    security: {
      ...options.security.runtimeIdentity(sessionId),
      ...(sessionWorkRootOf(sessionId) ? { sessionWorkRoot: sessionWorkRootOf(sessionId) } : {}),
      configFingerprint: options.security.runtimePolicyFingerprint(),
    },
    ...(options.toolPolicy ? { toolPolicyFingerprint: options.toolPolicy.runtimeFingerprint() } : {}),
    threatEngine: options.threatEngine ? { state: options.threatEngine.snapshot() } : false,
    rbac: options.rbac !== undefined,
    ...(options.callerRole ? { callerRole: options.callerRole } : {}),
    callContext: options.callContext ?? "api",
    ...(options.runId ? { runId: options.runId } : {}),
  };
}

export interface OpToolRuntimeOptions {
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId: string;
  callContext: CallContext;
  runId?: string;
  onEvent?: (event: ServerEvent) => void;
  /** External abort composed into the op-cancel bridge (e.g. run.ts's
   *  caller-supplied AbortSignal). Omit when op-cancel is the only trigger. */
  signal?: AbortSignal;
}

/**
 * Install the in-process tool runtime for an op whose descriptor already
 * carries a durable surface: cancel bridge, chat tool dispatcher (with the
 * onToolsAugmented / onRuntimeStateChange → persistRuntimeSurface wiring),
 * cleanup registration, and the per-op tool list. This is the FIRST-RUN twin
 * of rehydrateAgentRuntimeSurface — same registrations, but from live caller
 * state instead of a persisted surface. Returns the cancel bridge so runners
 * that manage their own lifetime (run.ts) can dispose it in their finally;
 * dispose is idempotent with the registered cleanup.
 */
export function installOpToolRuntime(op: Op, opts: OpToolRuntimeOptions): ToolCancelBridge {
  const cancelBridge = bridgeOpCancelToToolSignal(op.id, opts.signal);
  registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools: opts.tools,
    security: opts.security,
    toolPolicy: opts.toolPolicy,
    threatEngine: opts.threatEngine,
    rbac: opts.rbac,
    callerRole: opts.callerRole,
    sessionId: opts.sessionId,
    callContext: opts.callContext,
    opId: op.id,
    runId: opts.runId,
    onEvent: opts.onEvent,
    signal: cancelBridge.signal,
    onToolsAugmented: augmented => persistRuntimeSurface(op, current => ({
      ...current,
      tools: augmented.map(tool => ({ name: tool.name, fingerprint: toolFingerprint(tool) })),
    })),
    onRuntimeStateChange: () => persistRuntimeSurface(op, current => ({
      ...current,
      security: {
        ...opts.security.runtimeIdentity(opts.sessionId),
        ...(sessionWorkRootOf(opts.sessionId) ? { sessionWorkRoot: sessionWorkRootOf(opts.sessionId) } : {}),
        configFingerprint: current.security.configFingerprint,
      },
      threatEngine: opts.threatEngine ? { state: opts.threatEngine.snapshot() } : false,
    })),
  }));
  registerRuntimeCleanupForOp(op.id, () => cancelBridge.dispose());
  registerToolsForOp(op.id, opts.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  })));
  return cancelBridge;
}

export function rehydrateAgentRuntimeSurface(op: Op, surface: DelegatedRuntimeSurface): string {
  if (surface.kind !== "agent-runner") runtimeSurfaceMismatch("unsupported_surface");
  const tools = surface.tools.map(saved => {
    const tool = unifiedRegistry.get(saved.name);
    if (!tool || toolFingerprint(tool) !== saved.fingerprint) {
      runtimeSurfaceMismatch("tool_identity_changed");
    }
    return tool;
  });
  const security = new SecurityLayer(surface.security.workspace, surface.security.fileAccessMode);
  if (security.runtimePolicyFingerprint() !== surface.security.configFingerprint) {
    runtimeSurfaceMismatch("security_policy_changed");
  }
  const sessionId = op.runtimeDescriptor?.kind === "delegated-op" ? op.runtimeDescriptor.sessionId : undefined;
  if (!sessionId) runtimeSurfaceMismatch("session_identity_missing");
  if (surface.security.allowedPaths.some(entry => entry.sessionId !== "_global" && entry.sessionId !== sessionId)) {
    runtimeSurfaceMismatch("cross_session_authority");
  }
  try { security.restoreAllowedPaths(surface.security.allowedPaths); }
  catch { runtimeSurfaceMismatch("security_authority_invalid"); }
  const policy = surface.toolPolicyFingerprint ? loadToolPolicy(getLaxDir()) : undefined;
  if (surface.toolPolicyFingerprint && policy?.runtimeFingerprint() !== surface.toolPolicyFingerprint) {
    runtimeSurfaceMismatch("tool_policy_changed");
  }
  const threatEngine = surface.threatEngine ? new ThreatEngine(getLaxDir(), sessionId) : undefined;
  if (threatEngine && surface.threatEngine) {
    try { threatEngine.restore(surface.threatEngine.state); }
    catch { runtimeSurfaceMismatch("threat_state_invalid"); }
  }
  const rbac = surface.rbac ? new RBACManager(getLaxDir(), getRuntimeConfig().authToken) : undefined;
  const cancelBridge = bridgeOpCancelToToolSignal(op.id);
  const disposeWorkRoot = surface.security.sessionWorkRoot
    ? installSessionWorkRoot(sessionId, surface.security.sessionWorkRoot)
    : () => {};
  const persistState = () => persistRuntimeSurface(op, current => ({
    ...current,
    security: {
      ...security.runtimeIdentity(sessionId),
      ...(sessionWorkRootOf(sessionId) ? { sessionWorkRoot: sessionWorkRootOf(sessionId) } : {}),
      configFingerprint: current.security.configFingerprint,
    },
    threatEngine: threatEngine ? { state: threatEngine.snapshot() } : false,
  }));
  try { registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools,
    security,
    toolPolicy: policy,
    threatEngine,
    rbac,
    callerRole: surface.callerRole,
    sessionId,
    callContext: surface.callContext,
    opId: op.id,
    runId: surface.runId,
    signal: cancelBridge.signal,
    onEvent: event => broadcastToSession(sessionId, event),
    onToolsAugmented: augmented => persistRuntimeSurface(op, current => ({
      ...current,
      tools: augmented.map(tool => ({ name: tool.name, fingerprint: toolFingerprint(tool) })),
    })),
    onRuntimeStateChange: persistState,
  }));
  registerRuntimeCleanupForOp(op.id, () => {
    cancelBridge.dispose();
    disposeWorkRoot();
  });
  registerToolsForOp(op.id, tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  })));
  } catch (error) {
    cancelBridge.dispose();
    disposeWorkRoot();
    if (error instanceof RuntimeSurfaceMismatchError) throw error;
    runtimeSurfaceMismatch("surface_registration_failed");
  }
  return surface.systemPrompt;
}

export function persistRuntimeSurface(
  op: Op,
  update: (surface: DelegatedRuntimeSurface) => DelegatedRuntimeSurface,
): void {
  withOpLock(op.id, () => {
    const fresh = readOp(op.id) ?? op;
    verifyDelegatedRuntimeIntegrity(fresh);
    if (!fresh.runtimeDescriptor.surface) throw new Error("delegated operation has no durable runtime surface");
    const { integrity: _integrity, ...identity } = fresh.runtimeDescriptor;
    const sealed = sealDelegatedRuntime(op.id, { ...identity, surface: update(fresh.runtimeDescriptor.surface) });
    fresh.runtimeDescriptor = sealed;
    op.runtimeDescriptor = sealed;
    writeOp(fresh);
    const persisted = readOp(op.id);
    if (!persisted || persisted.runtimeDescriptor?.kind !== "delegated-op"
      || persisted.runtimeDescriptor.adapter !== "provider-exact"
      || persisted.runtimeDescriptor.integrity.mac !== sealed.integrity.mac) {
      throw new Error("failed to persist delegated runtime state");
    }
  });
}

export function toolFingerprint(tool: ToolDefinition): string {
  const registryEntry = unifiedRegistry.getEntry(tool.name);
  const implementationFingerprint = implementationFingerprintFor(tool);
  const policies = Object.entries(TOOL_POLICIES)
    .filter(([pattern]) => matchGlob(pattern, tool.name))
    .map(([pattern, policy]) => ({ pattern, policy }));
  const identity = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    effect: typeof tool.effect === "function" ? String(tool.effect) : tool.effect,
    readOnly: tool.readOnly,
    concurrencySafe: tool.concurrencySafe,
    implementationFingerprint,
    provenanceFingerprint: registryEntry?.tool === tool
      ? registryEntry.implementationFingerprint
      : implementationFingerprint,
    policies,
  };
  return hash(stableStringify(identity));
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
