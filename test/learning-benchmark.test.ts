import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "../src/tool-execution/context.js";
import type { LAXConfig, ServerEvent, ToolDefinition } from "../src/types.js";
import type { Op } from "../src/ops/types.js";

let root = "";
let priorDataDir: string | undefined;
let originalConfig: LAXConfig;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lax-learning-benchmark-"));
  priorDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = join(root, "data");
  vi.resetModules();
  const config = await import("../src/config.js");
  originalConfig = config.getRuntimeConfig();
  config.setRuntimeConfig({ ...originalConfig, workspace: join(root, "workspace") } as LAXConfig);
  (await import("../src/ari-kernel/state.js")).setAriRequired(false);
});

afterEach(async () => {
  const canonical = await import("../src/canonical-loop/index.js");
  await canonical.awaitIdle(2_000).catch(() => undefined);
  canonical.resetScheduler();
  canonical.resetCanonicalRuntime();
  canonical.resetBus();
  const config = await import("../src/config.js");
  config.setRuntimeConfig(originalConfig);
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(root, { recursive: true, force: true });
});

async function system() {
  const [canonical, opStore, sessions, fake, learning, lifecycle, tools, context, policy, resolveTool] = await Promise.all([
    import("../src/canonical-loop/index.js"), import("../src/ops/op-store.js"),
    import("../src/ops/session-bridge.js"), import("./canonical-loop/fake-adapter.js"),
    import("../src/cognition/cross-session-learning/index.js"), import("../src/protocols/learned-lifecycle.js"),
    import("../src/protocols/protocol-tool.js"), import("../src/tool-execution/context.js"),
    import("../src/tool-execution/enforce-policy.js"), import("../src/tool-execution/resolve-tool.js"),
  ]);
  return { canonical, opStore, sessions, fake, learning, lifecycle, tools, context, policy, resolveTool };
}

function operation(id: string, rawPrompt: string): Op {
  return {
    id, type: "freeform", task: rawPrompt, model: "benchmark-model",
    contextPack: {
      task: { description: rawPrompt, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: { needsTools: true },
      budget: { maxIterations: 8, maxTokens: 10_000, maxWallTimeMs: 60_000, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" }, secrets: { allowed: [] },
    },
    lane: "interactive", retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] },
    ownerId: "learning-benchmark", visibility: "private", status: "pending",
    createdAt: new Date().toISOString(), attemptCount: 0,
  };
}

async function commitWorkflow(
  s: Awaited<ReturnType<typeof system>>, id: string, sessionId: string,
  sentinels: { prompt: string; arg: string; result: string; secret: string; unrelated: string },
): Promise<void> {
  const current = operation(id, sentinels.prompt);
  current.contextPack.context.memoryHits = [sentinels.unrelated];
  current.contextPack.secrets.allowed = [sentinels.secret];
  s.sessions.trackOpForSession(id, sessionId, current.task);
  s.canonical.setToolDispatcher({
    dispatch: async (call) => ({
      toolCallId: call.toolCallId, status: "ok",
      result: { privateResult: sentinels.result, resolvedSecret: sentinels.secret }, durationMs: 1,
    }),
  });
  s.canonical.registerAdapterForOp(id, () => new s.fake.FakeAdapter({
    script: s.fake.scriptMultiTurn([
      { toolCalls: [{ toolCallId: `${id}-read`, tool: "read", args: { path: sentinels.arg } }] },
      { toolCalls: [{ toolCallId: `${id}-write`, tool: "write", args: { path: sentinels.arg } }] },
      { toolCalls: [{ toolCallId: `${id}-bash`, tool: "bash", args: { command: sentinels.arg } }] },
      { text: "verified", terminal: "done" },
    ]),
  }));
  s.canonical.canonicalLoopEntry(current);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const saved = s.opStore.readOp(id);
    if (saved?.canonical?.state === "succeeded") return;
    if (Date.now() > deadline) throw new Error(`terminal timeout: ${id}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function remember(content: string, sessionId: string, tainted: boolean) {
  const profile = await import("../src/autonomy/profile-store.js");
  const lineage = await import("../src/data-lineage/external.js");
  const approval = await import("../src/tool-execution/require-approval.js");
  const memoryModule = await import("../src/memory/index.js");
  const facts = await import("../src/memory/tools/facts.js");
  profile.setSessionProfile(sessionId, "Normal");
  if (tainted) lineage.recordExternalIngestion(sessionId);
  const memoryDir = join(root, `memory-${sessionId}`);
  const memory = new memoryModule.MemoryIndex(memoryDir, { minScore: -1 });
  const events: ServerEvent[] = [];
  const args: Record<string, unknown> = {
    content, provenance: "user_statement", confidence: 1, _sessionId: sessionId,
  };
  const ctx = {
    tc: { id: `remember-${sessionId}`, name: "remember", arguments: JSON.stringify(args) },
    sessionId, callContext: "local", args,
    priorMessages: [{ role: "user", content: `Please remember that ${content}.` }],
    onEvent: (event: ServerEvent) => events.push(event), approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
  expect((await approval.requireApprovalPhase(ctx)).kind).toBe("continue");
  expect(events.some((event) => event.type === "approval_requested")).toBe(false);
  const result = await facts.createFactsTools(memory).find((entry) => entry.name === "remember")!.execute(ctx.args);
  expect(result.isError, result.content).toBeUndefined();
  memory.close();
  const reopened = new memoryModule.MemoryIndex(memoryDir, { minScore: -1 });
  const retained = reopened.recallByKind("observation");
  const rendered = await (await import("../src/memory/context.js")).buildContextBlock(reopened, { skipDailyLog: true });
  reopened.close();
  profile.clearSessionProfile(sessionId);
  lineage.clearExternalIngestion(sessionId);
  return { fact: retained[0], rendered };
}

function persistedText(dir: string, exclude: (path: string) => boolean): string {
  const chunks: string[] = [];
  const walk = (path: string) => {
    if (exclude(path)) return;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else chunks.push(readFileSync(child).toString("utf8"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

function restartSnapshot(dataDir: string, now: number) {
  const worker = join(root, "restart-snapshot.mts");
  const learnerUrl = pathToFileURL(resolve("src/cognition/cross-session-learning/index.ts")).href;
  const serviceUrl = pathToFileURL(resolve("src/cognition/cross-session-learning/service.ts")).href;
  const lifecycleUrl = pathToFileURL(resolve("src/protocols/learned-lifecycle.ts")).href;
  const configUrl = pathToFileURL(resolve("src/config.ts")).href;
  writeFileSync(worker, `
    import learner from ${JSON.stringify(learnerUrl)};
    import { CrossSessionLearningService } from ${JSON.stringify(serviceUrl)};
    import { loadLearnedProtocol } from ${JSON.stringify(lifecycleUrl)};
    import { getRuntimeConfig, setRuntimeConfig } from ${JSON.stringify(configUrl)};
    setRuntimeConfig({ ...getRuntimeConfig(), workspace: ${JSON.stringify(join(root, "restart-workspace"))} });
    learner.refresh();
    const service = new CrossSessionLearningService(learner);
    const before = service.list();
    const replay = service.reconcile("autonomous", ${now});
    const after = service.list();
    const record = loadLearnedProtocol(after[0].id);
    process.stdout.write(JSON.stringify({ before, after, replay, versions: record.versions.length, active: record.activeVersionId }));
    process.exit(0);
  `);
  const child = spawnSync(process.execPath, ["--import=tsx", worker], {
    encoding: "utf8", env: { ...process.env, LAX_DATA_DIR: dataDir }, timeout: 15_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    before: Array<{ id: string; activeVersionId: string | null; versionCount: number }>;
    after: Array<{ id: string; activeVersionId: string | null; versionCount: number }>;
    replay: { changed: boolean; signals: unknown[] }; versions: number; active: string | null;
  };
}

describe("G4 deterministic learning benchmark", () => {
  it("keeps memory provenance and capability evidence isolated without prompts", async () => {
    const memorySentinel = `MEMORY_${process.hrtime.bigint().toString(36)}`;
    const taintedSentinel = `TAINTED_${process.hrtime.bigint().toString(36)}`;
    const clean = await remember(`User prefers ${memorySentinel}`, "memory-clean", false);
    const tainted = await remember(`Remote page claims ${taintedSentinel}`, "memory-tainted", true);
    expect(clean.fact.sourceFile).toBe("agent-tool:user-statement");
    expect(clean.fact.provenance).toBe("user_statement");
    expect(clean.rendered).toContain(memorySentinel);
    expect(clean.rendered).not.toContain("UNTRUSTED");
    expect(tainted.fact.sourceFile).toContain("tainted-external");
    expect(tainted.rendered).toContain(taintedSentinel);
    expect(tainted.rendered).toContain("UNTRUSTED");
    expect(tainted.rendered).toContain("trust=untrusted taint=tainted");

    const caps = await import("../src/providers/model-capabilities-store.js");
    const settings = await import("../src/settings.js");
    const local = "http://127.0.0.1:11434/v1";
    const cloud = "https://example.invalid/v1";
    const selectedBefore = settings.loadSettings() as { provider?: string; model?: string };
    caps.recordToolsVerified(local, "same-model", true);
    caps.recordNoTools(local, "local-only-model");
    caps._resetForTests();
    expect(caps.getToolsVerified(local, "same-model")?.ok).toBe(true);
    expect(caps.getToolsVerified(cloud, "same-model")).toBeUndefined();
    expect(caps.getToolsVerified(local, "other-model")).toBeUndefined();
    expect(caps.hasNoTools(cloud, "local-only-model")).toBe(false);
    const selectedAfter = settings.loadSettings() as { provider?: string; model?: string };
    expect({ provider: selectedAfter.provider, model: selectedAfter.model })
      .toEqual({ provider: selectedBefore.provider, model: selectedBefore.model });
  });

  it("learns only canonical clean terminals, activates by mode, and replays idempotently after restart", async () => {
    const s = await system();
    const learner = s.learning.CrossSessionLearner.getInstance();
    const service = new (await import("../src/cognition/cross-session-learning/service.js")).CrossSessionLearningService(learner);
    const nonce = process.hrtime.bigint().toString(36);
    const secrets = {
      prompt: `RAW_PROMPT_${nonce}`, arg: `RAW_ARG_${nonce}`, result: `RAW_RESULT_${nonce}`,
      secret: `SECRET_${nonce}`, unrelated: `UNRELATED_MEMORY_${nonce}`,
    };
    for (let index = 0; index < 3; index++) {
      await commitWorkflow(s, `clean-${nonce}-${index}`, `clean-session-${index}`, secrets);
    }
    const lineage = await import("../src/data-lineage/external.js");
    lineage.recordExternalIngestion(`tainted-session-${nonce}`);
    await commitWorkflow(s, `tainted-${nonce}`, `tainted-session-${nonce}`, secrets);
    lineage.clearExternalIngestion(`tainted-session-${nonce}`);

    const patterns = learner.detectPatterns(3);
    const workflow = patterns.find((entry) => entry.examples[0] === "read -> write -> bash")!;
    expect(workflow).toMatchObject({ occurrences: 3, outcomeStats: { clean: 3, distinctSessions: 3 } });
    const base = Date.now();
    const approvalManager = (await import("../src/approval-manager.js")).getApprovalManager();
    const approvalSpy = vi.spyOn(approvalManager, "requestApprovalDetailed");
    expect(service.reconcile("assisted", base)).toMatchObject({ changed: true, signals: [{ category: "learning-candidate" }] });
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]).toMatchObject({ state: "candidate", activeVersionId: null, versionCount: 1 });
    expect(service.reconcile("autonomous", base + 1).changed).toBe(true);
    expect(approvalSpy).not.toHaveBeenCalled();
    const activated = service.list()[0];
    expect(activated).toMatchObject({ state: "active", versionCount: 1 });
    expect(activated.activeVersionId).toBeTruthy();

    const protocol = s.tools.createProtocolFamilyTools().find((entry) => entry.name === "protocol")!;
    const selectedOp = operation(`selected-${nonce}`, secrets.prompt);
    selectedOp.status = "running";
    selectedOp.canonical = { flagValue: true, state: "running" };
    s.opStore.writeOp(selectedOp);
    const selectCtx = s.context.createContext({
      tc: { id: "select", name: "protocol", arguments: JSON.stringify({ action: "get", params: { name: activated.id } }) },
      toolMap: new Map([[protocol.name, protocol]]), security: { evaluate: () => ({ allowed: true }) } as never,
      operationId: selectedOp.id, callContext: "local",
    });
    expect((await s.resolveTool.resolvePhase(selectCtx)).kind).toBe("continue");
    expect((await protocol.execute(selectCtx.args)).isError).toBeUndefined();
    const deniedExecute = vi.fn(async () => ({ content: "must not execute" }));
    const deniedTool: ToolDefinition = {
      name: "read", description: "read", parameters: { type: "object", properties: {} }, readOnly: true,
      execute: deniedExecute,
    };
    const deniedCtx = s.context.createContext({
      tc: { id: "denied", name: "read", arguments: "{}" }, toolMap: new Map([["read", deniedTool]]),
      security: { evaluate: () => ({ allowed: false, reason: "canonical policy denial" }) } as never,
      operationId: selectedOp.id, callContext: "local",
    });
    await s.resolveTool.resolvePhase(deniedCtx);
    expect((await s.policy.enforcePolicyPhase(deniedCtx)).kind).toBe("block");
    expect(deniedCtx.result?.metadata?.layer).toBe("security");
    expect(deniedExecute).not.toHaveBeenCalled();

    (await import("../src/canonical-loop/state-machine.js")).transitionOp(selectedOp, "succeeded", "turn_done", {
      learnedOutcome: "clean", learningSessionId: `selected-session-${nonce}`,
    });
    const receipt = (await import("../src/protocols/learned-effectiveness.js")).readLearnedOutcome(selectedOp.id)!;
    expect(Object.keys(receipt).sort()).toEqual([
      "candidateId", "opId", "outcome", "schemaVersion", "sessionId", "slug", "status", "timestamp", "versionId",
    ]);
    expect(receipt).toMatchObject({ status: "committed", outcome: "clean", slug: activated.id });

    expect(service.reconcile("autonomous", base + 2)).toEqual({ changed: false, signals: [] });
    const child = restartSnapshot(process.env.LAX_DATA_DIR!, base + 3);
    expect(child.before).toEqual(child.after);
    expect(child.after).toHaveLength(1);
    expect(child.after[0]).toMatchObject({ id: activated.id, activeVersionId: activated.activeVersionId, versionCount: 1 });
    expect(child).toMatchObject({ replay: { changed: false, signals: [] }, versions: 1, active: activated.activeVersionId });

    const dataDir = process.env.LAX_DATA_DIR!;
    const privacyFiles = [readFileSync(join(dataDir, "cross-session-data.json"), "utf8")];
    const protocolsDir = join(dataDir, "protocols");
    if (existsSync(protocolsDir)) privacyFiles.push(persistedText(protocolsDir, () => false));
    const effectivenessDir = join(root, "workspace", "protocols", "effectiveness");
    if (existsSync(effectivenessDir)) privacyFiles.push(persistedText(effectivenessDir, () => false));
    const capabilitiesFile = join(dataDir, "model-capabilities.json");
    if (existsSync(capabilitiesFile)) privacyFiles.push(readFileSync(capabilitiesFile, "utf8"));
    const durable = privacyFiles.join("\n");
    for (const sentinel of Object.values(secrets)) expect(durable).not.toContain(sentinel);
    const learningData = JSON.parse(readFileSync(join(process.env.LAX_DATA_DIR!, "cross-session-data.json"), "utf8"));
    expect(learningData.actions).toHaveLength(4);
    for (const action of learningData.actions) {
      expect(Object.keys(action).sort()).toEqual([
        "authority", "category", "details", "evidenceClass", "model", "opId", "outcome", "sessionId",
        "timestamp", "tools", "type",
      ]);
      expect(action.tools).toEqual(action.opId === selectedOp.id ? [] : ["read", "write", "bash"]);
    }
  }, 30_000);
});
