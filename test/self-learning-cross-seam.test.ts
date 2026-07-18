import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { MemoryManager } from "../src/memory/index.js";
import type { LAXConfig, ToolDefinition } from "../src/types.js";
import type { Op } from "../src/ops/types.js";

const DAY = 86_400_000;
let root = "";
let priorDataDir: string | undefined;
let originalConfig: LAXConfig;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lax-self-learning-cross-seam-"));
  priorDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = join(root, "data");
  vi.resetModules();
  const config = await import("../src/config.js");
  originalConfig = config.getRuntimeConfig();
  config.setRuntimeConfig({ ...originalConfig, workspace: join(root, "workspace") } as LAXConfig);
  const ari = await import("../src/ari-kernel/state.js");
  ari.setAriRequired(false);
});

afterEach(async () => {
  const canonical = await import("../src/canonical-loop/index.js");
  await canonical.awaitIdle(2_000).catch(() => undefined);
  canonical.resetScheduler();
  canonical.resetCanonicalRuntime();
  canonical.resetBus();
  const effectiveness = await import("../src/protocols/learned-effectiveness.js");
  effectiveness._setLearnedEffectivenessWriteHookForTests();
  const config = await import("../src/config.js");
  config.setRuntimeConfig(originalConfig);
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function system() {
  const [canonical, runtime, opStore, sessions, fake, learning, lifecycle, protocols, tools, policy, context, effectiveness, stateMachine] = await Promise.all([
    import("../src/canonical-loop/index.js"),
    import("../src/canonical-loop/runtime.js"),
    import("../src/ops/op-store.js"),
    import("../src/ops/session-bridge.js"),
    import("./canonical-loop/fake-adapter.js"),
    import("../src/cognition/cross-session-learning/index.js"),
    import("../src/protocols/learned-lifecycle.js"),
    import("../src/protocols/index.js"),
    import("../src/protocols/protocol-tool.js"),
    import("../src/tool-execution/enforce-policy.js"),
    import("../src/tool-execution/context.js"),
    import("../src/protocols/learned-effectiveness.js"),
    import("../src/canonical-loop/state-machine.js"),
  ]);
  return { canonical, runtime, opStore, sessions, fake, learning, lifecycle, protocols, tools, policy, context, effectiveness, stateMachine };
}

function op(id: string, state: "pending" | "running" = "pending"): Op {
  return {
    id, type: "freeform", task: "verified file release workflow", model: "test-model",
    contextPack: {
      task: { description: "workflow", successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: { needsTools: true },
      budget: { maxIterations: 8, maxTokens: 10_000, maxWallTimeMs: 60_000, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" }, secrets: { allowed: [] },
    },
    lane: "interactive", retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] },
    ownerId: "cross-seam", visibility: "private", status: state,
    createdAt: new Date().toISOString(), attemptCount: 0,
    ...(state === "running" ? { canonical: { flagValue: true, state: "running" as const } } : {}),
  };
}

async function awaitTerminal(readOp: (id: string) => Op | null, id: string): Promise<Op> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const current = readOp(id);
    if (current && ["succeeded", "failed", "cancelled"].includes(current.canonical?.state ?? "")) return current;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function commitOrdinaryWorkflow(s: Awaited<ReturnType<typeof system>>, id: string, sessionId: string): Promise<void> {
  const current = op(id);
  s.sessions.trackOpForSession(id, sessionId, current.task);
  s.canonical.setToolDispatcher({
    dispatch: async (call) => ({ toolCallId: call.toolCallId, status: "ok", result: { ok: true }, durationMs: 1 }),
  });
  s.canonical.registerAdapterForOp(id, () => new s.fake.FakeAdapter({
    script: s.fake.scriptMultiTurn([
      { toolCalls: [{ toolCallId: `${id}-read`, tool: "read", args: { path: "release.txt" } }] },
      { toolCalls: [{ toolCallId: `${id}-write`, tool: "write", args: { path: "release.txt" } }] },
      { toolCalls: [{ toolCallId: `${id}-bash`, tool: "bash", args: { command: "verify" } }] },
      { text: "verified", terminal: "done" },
    ]),
  }));
  s.canonical.canonicalLoopEntry(current);
  const terminal = await awaitTerminal(s.opStore.readOp, id);
  expect(terminal.canonical?.state, JSON.stringify(s.canonical.readCanonicalEvents(id))).toBe("succeeded");
}

function allowSecurity() {
  return { evaluate: () => ({ allowed: true }) } as never;
}

function tool(name: string, execute: ReturnType<typeof vi.fn>): ToolDefinition {
  return {
    name, description: `${name} test tool`, parameters: { type: "object", properties: {} },
    execute, readOnly: true,
  };
}

async function selectProtocol(
  s: Awaited<ReturnType<typeof system>>,
  operationId: string,
  slug: string,
): Promise<string> {
  const protocol = s.tools.createProtocolFamilyTools().find((entry) => entry.name === "protocol")!;
  const ctx = s.context.createContext({
    tc: {
      id: `select-${operationId}`, name: "protocol",
      arguments: JSON.stringify({ action: "get", _operationId: "forged-flat", params: { name: slug, _operationId: "forged-nested" } }),
    },
    toolMap: new Map([[protocol.name, protocol]]), security: allowSecurity(), operationId, callContext: "local",
  });
  const resolve = await import("../src/tool-execution/resolve-tool.js");
  expect((await resolve.resolvePhase(ctx)).kind).toBe("continue");
  const result = await protocol.execute(ctx.args);
  return result.content;
}

async function selectedOutcome(
  s: Awaited<ReturnType<typeof system>>,
  slug: string,
  id: string,
  outcome: "clean" | "partial" | "aborted",
  sessionId: string,
): Promise<void> {
  const current = op(id, "running");
  s.opStore.writeOp(current);
  await selectProtocol(s, id, slug);
  s.stateMachine.transitionOp(
    current,
    outcome === "aborted" ? "failed" : "succeeded",
    outcome === "clean" ? "turn_done" : outcome === "partial" ? "iteration_checkpoint" : "worker_exception",
    { learnedOutcome: outcome, learningSessionId: sessionId },
  );
}

function memoryManager(): MemoryManager {
  return {
    buildTurnContext: vi.fn(async () => ({
      contextBlock: "profile", relevantMemories: "memory", smartContext: "prior context",
      memoryContext: "memory context", notifications: [], knownProjectsFound: false,
    })),
  } as unknown as MemoryManager;
}

describe.each(["assisted", "autonomous"] as const)("self-learning cross-seam (%s safety policy)", (rollbackMode) => {
  it("proves evidence through selection, enforcement, effectiveness, refinement, and rollback", async () => {
    const s = await system();
    const learner = s.learning.CrossSessionLearner.getInstance();
    const serviceModule = await import("../src/cognition/cross-session-learning/service.js");
    const service = new serviceModule.CrossSessionLearningService(learner);
    const base = Date.now();

    for (let index = 0; index < 3; index++) {
      await commitOrdinaryWorkflow(s, `ordinary-${rollbackMode}-${index}`, `ordinary-session-${index}`);
    }
    const pattern = learner.detectPatterns(3).find((entry) => entry.examples[0] === "read -> write -> bash")!;
    expect(pattern, JSON.stringify(learner.detectPatterns(3))).toBeDefined();
    expect(pattern.examples[0]).toBe("read -> write -> bash");
    expect(pattern.outcomeStats).toMatchObject({ clean: 3, distinctSessions: 3, successRate: 1 });

    const assisted = service.reconcile("assisted", base + 100);
    const candidate = learner.getCandidates()[0];
    expect(assisted).toMatchObject({ changed: true, signals: [{ category: "learning-candidate" }] });
    expect(candidate.evidence.examples[0]).toBe("read -> write -> bash");
    expect(service.list()[0]).toMatchObject({ state: "candidate", activeVersionId: null, versionCount: 1 });
    const suggestionModule = await import("../src/protocols/learned-suggestion.js");
    expect(suggestionModule.getLearnedProtocolSuggestion("read write bash release files")).toBeNull();
    expect(s.protocols.getAllProtocols().some((entry) => entry.name === candidate.id)).toBe(false);

    service.reconcile("autonomous", base + 101);
    const firstVersion = service.list()[0].activeVersionId!;
    expect(service.list()[0]).toMatchObject({ state: "active", versionCount: 1 });
    const firstRecord = s.lifecycle.loadLearnedProtocol(candidate.id);
    expect(firstRecord.activeVersionId).toBe(firstVersion);

    const build = await import("../src/agent-request/prepare-request/build-context.js");
    const strong = await build.buildContext({
      message: "read write bash release files", sessionId: "context-one", sessionMessages: [],
      memoryManager: memoryManager(), isCodexProvider: false, isTrivialToolRequest: false,
      tier: "strong", resolvedModel: "test",
    });
    const weak = await build.buildContext({
      message: "read write bash release files again", sessionId: "context-two", sessionMessages: [],
      memoryManager: memoryManager(), isCodexProvider: false, isTrivialToolRequest: false,
      tier: "weak", resolvedModel: "test",
    });
    for (const context of [strong.smartContext, weak.smartContext]) {
      expect(context).toContain(`protocol(action:"get", params:{name:"${candidate.id}"})`);
      expect(context).not.toContain("allowed-tools");
      expect(context.length).toBeLessThan(260);
    }
    expect(weak.contextBlock).toBe("");

    const executionOp = op(`selected-main-${rollbackMode}`, "running");
    s.opStore.writeOp(executionOp);
    const body = await selectProtocol(s, executionOp.id, candidate.id);
    const envelope = s.runtime.getLearnedProtocolEnvelopeForOp(executionOp.id)!;
    expect(body).toContain(`# Protocol: ${candidate.id}`);
    expect(envelope).toEqual({
      slug: candidate.id, versionId: firstVersion, candidateId: candidate.id,
      allowedTools: ["read", "write", "bash"],
    });
    expect(s.runtime.getLearnedProtocolEnvelopeForOp("forged-flat")).toBeNull();
    expect(s.runtime.getLearnedProtocolEnvelopeForOp("forged-nested")).toBeNull();

    const allowed = vi.fn(async () => ({ content: "allowed" }));
    const denied = vi.fn(async () => ({ content: "must not run" }));
    const toolMap = new Map([["read", tool("read", allowed)], ["web_search", tool("web_search", denied)]]);
    const resolve = await import("../src/tool-execution/resolve-tool.js");
    const allowedCtx = s.context.createContext({
      tc: { id: "allowed", name: "read", arguments: "{}" }, toolMap,
      security: allowSecurity(), operationId: executionOp.id, callContext: "local",
    });
    await resolve.resolvePhase(allowedCtx);
    expect((await s.policy.enforcePolicyPhase(allowedCtx)).kind).toBe("continue");
    const allowedResult = await allowedCtx.tool!.execute(allowedCtx.args);
    const deniedCtx = s.context.createContext({
      tc: { id: "denied", name: "web_search", arguments: "{}" }, toolMap,
      security: allowSecurity(), operationId: executionOp.id, callContext: "local",
    });
    await resolve.resolvePhase(deniedCtx);
    expect((await s.policy.enforcePolicyPhase(deniedCtx)).kind).toBe("halt");
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(allowedResult).toEqual({ content: "allowed" });
    expect(denied).not.toHaveBeenCalled();
    expect(deniedCtx.result?.content).toContain("learned protocol envelope");

    const securityCtx = s.context.createContext({
      tc: { id: "security", name: "read", arguments: "{}" }, toolMap,
      security: { evaluate: () => ({ allowed: false, reason: "ordinary security denial" }) } as never,
      operationId: executionOp.id, callContext: "local",
    });
    await (await import("../src/tool-execution/resolve-tool.js")).resolvePhase(securityCtx);
    expect((await s.policy.enforcePolicyPhase(securityCtx)).kind).toBe("block");
    expect(securityCtx.result?.metadata?.layer).toBe("security");

    s.stateMachine.transitionOp(executionOp, "succeeded", "turn_done", {
      learnedOutcome: "clean", learningSessionId: "selected-session-main",
    });
    const mainReceipt = s.effectiveness.readLearnedOutcome(executionOp.id)!;
    expect(mainReceipt).toEqual({
      schemaVersion: 1, status: "committed", opId: executionOp.id,
      sessionId: "selected-session-main", slug: candidate.id, versionId: firstVersion,
      candidateId: candidate.id, outcome: "clean", timestamp: expect.any(Number),
    });
    expect(Object.keys(mainReceipt).sort()).toEqual([
      "candidateId", "opId", "outcome", "schemaVersion", "sessionId", "slug", "status", "timestamp", "versionId",
    ]);

    for (let index = 1; index < 5; index++) {
      await selectedOutcome(s, candidate.id, `healthy-${rollbackMode}-${index}`, "clean", `healthy-session-${index}`);
    }
    expect(s.effectiveness.getVersionEffectiveness(candidate.id, firstVersion)).toMatchObject({
      total: 5, clean: 5, distinctSessions: 5, qualityScore: 1,
    });

    for (let index = 3; index < 6; index++) {
      await commitOrdinaryWorkflow(s, `stronger-${rollbackMode}-${index}`, `stronger-session-${index}`);
    }
    vi.useFakeTimers();
    vi.setSystemTime(base + 8 * DAY);
    service.reconcile("assisted", base + 8 * DAY);
    const drafted = service.list()[0];
    expect(drafted).toMatchObject({ activeVersionId: firstVersion, versionCount: 2, state: "active" });
    const refinedRecord = s.lifecycle.loadLearnedProtocol(candidate.id);
    const secondVersion = refinedRecord.versions.at(-1)!.id;
    expect(secondVersion).not.toBe(firstVersion);
    const firstDir = join(root, "workspace", "protocols", "imported", candidate.id, "versions", firstVersion);
    const immutableBefore = [readFileSync(join(firstDir, "SKILL.md"), "utf8"), readFileSync(join(firstDir, "meta.json"), "utf8")];

    service.reconcile("autonomous", base + 8 * DAY + 1);
    expect(service.list()[0].activeVersionId).toBe(secondVersion);
    expect(service.reconcile(rollbackMode, base + 8 * DAY + 2)).toEqual({ signals: [], changed: false });
    expect(service.list()[0].activeVersionId).toBe(secondVersion);
    vi.setSystemTime(base + 8 * DAY + 10);
    const staleOp = op(`stale-${rollbackMode}`, "running");
    s.opStore.writeOp(staleOp);
    await selectProtocol(s, staleOp.id, candidate.id);
    for (const [index, outcome] of (["aborted", "clean", "aborted"] as const).entries()) {
      await selectedOutcome(s, candidate.id, `regression-${rollbackMode}-${index}`, outcome, `regression-session-${index}`);
    }

    service.reconcile(rollbackMode, base + 8 * DAY + 20);
    expect(service.list()[0]).toMatchObject({ state: "active", activeVersionId: firstVersion, versionCount: 2 });
    expect(s.lifecycle.loadLearnedProtocol(candidate.id).activationHistory?.at(-1)).toMatchObject({
      kind: "rollback", versionId: firstVersion, previousVersionId: secondVersion,
      reason: "Safety rollback: hard regression",
    });
    expect(await (await import("../src/tool-execution/learned-protocol-envelope.js")).learnedProtocolEnvelopeGate(
      s.context.createContext({
        tc: { id: "stale-read", name: "read", arguments: "{}" }, toolMap,
        security: allowSecurity(), operationId: staleOp.id, callContext: "local",
      }),
    )).toMatchObject({ kind: "halt" });
    expect([readFileSync(join(firstDir, "SKILL.md"), "utf8"), readFileSync(join(firstDir, "meta.json"), "utf8")]).toEqual(immutableBefore);
    expect(service.reconcile(rollbackMode, base + 8 * DAY + 21)).toEqual({ signals: [], changed: false });
  }, 60_000);
});

describe("self-learning terminal integrity", () => {
  it("scores a forced partial, excludes cancellation, and reconciles a persistence-interrupted receipt", async () => {
    const s = await system();
    const lifecycle = s.lifecycle.createLearnedProtocolDraft({
      slug: `learned-${createHash("sha256").update("terminal-integrity").digest("hex").slice(0, 20)}`,
      skillMd: `---\nname: learned-${createHash("sha256").update("terminal-integrity").digest("hex").slice(0, 20)}\ndescription: terminal integrity release verification\nallowed-tools: [read]\n---\nVerify the release.\n`,
      metadata: { candidateId: `learned-${createHash("sha256").update("terminal-integrity").digest("hex").slice(0, 20)}`, allowedTools: ["read"], toolSequence: ["read"] },
    });
    s.lifecycle.activateLearnedProtocol({ slug: lifecycle.record.slug, versionId: lifecycle.version.id, expectedActiveVersionId: null });

    await selectedOutcome(s, lifecycle.record.slug, "forced-partial", "partial", "forced-session");
    expect(s.effectiveness.readLearnedOutcome("forced-partial")).toMatchObject({ status: "committed", outcome: "partial" });
    const learningStore = join(process.env.LAX_DATA_DIR!, "cross-session-data.json");
    const afterForced = readFileSync(learningStore, "utf8");

    const cancelled = op("explicit-cancel", "running");
    s.opStore.writeOp(cancelled);
    await selectProtocol(s, cancelled.id, lifecycle.record.slug);
    cancelled.canonical!.state = "cancelling";
    s.stateMachine.transitionOp(cancelled, "cancelled", "adapter_aborted");
    expect(s.effectiveness.readLearnedOutcome(cancelled.id)).toBeNull();
    expect(readFileSync(learningStore, "utf8")).toBe(afterForced);

    const interrupted = op("persistence-interrupted", "running");
    s.opStore.writeOp(interrupted);
    await selectProtocol(s, interrupted.id, lifecycle.record.slug);
    const operationDir = join(process.env.LAX_DATA_DIR!, "operations", interrupted.id);
    s.effectiveness._setLearnedEffectivenessWriteHookForTests((_phase, receipt) => {
      if (receipt.status === "pending") chmodSync(operationDir, 0o500);
    });
    try {
      expect(() => s.stateMachine.transitionOp(interrupted, "succeeded", "turn_done", {
        learnedOutcome: "clean", learningSessionId: "restart-session",
      })).toThrow();
    } finally {
      chmodSync(operationDir, 0o700);
      s.effectiveness._setLearnedEffectivenessWriteHookForTests();
    }
    const pending = s.effectiveness.readLearnedOutcome(interrupted.id)!;
    expect(pending).toMatchObject({ status: "pending", outcome: "clean" });
    expect(s.opStore.readOp(interrupted.id)?.canonical?.state).toBe("running");
    expect(readFileSync(learningStore, "utf8")).toBe(afterForced);
    expect((await import("../src/canonical-loop/learned-effectiveness.js")).reconcileCanonicalLearnedOutcomes().retained).toContain(interrupted.id);

    const recovered = s.opStore.readOp(interrupted.id)!;
    recovered.canonical!.state = "succeeded";
    recovered.status = "completed";
    s.opStore.writeOp(recovered);
    const report = (await import("../src/canonical-loop/learned-effectiveness.js")).reconcileCanonicalLearnedOutcomes();
    expect(report.committed).toContain(interrupted.id);
    expect(s.effectiveness.readLearnedOutcome(interrupted.id)).toMatchObject({ status: "committed", timestamp: pending.timestamp });
  });
});
