/**
 * Cross-seam contract test for the delegated-worker-toolset fix (152ff5fd +
 * 789e7940).
 *
 * The pre-fix failure: an op_submit_async-spawned op sealed its provider /
 * model / session but registered NO toolset and NO dispatcher, so the model saw
 * `tools: []` on turn 0 and every tool call hit NotConfiguredToolDispatcher —
 * the op looped on error strings until its budget died (the "2am mission" voice
 * failure).
 *
 * The unit suites prove pieces in isolation with everything mocked:
 *   - src/ops/tools/delegated-runtime.test.ts    — configureDelegatedRuntime,
 *       but buildAgentRuntimeSurface / installOpToolRuntime / the belt chooser
 *       are all faked, so it pins what shared.ts PASSES, not what the runtime
 *       singletons END UP holding.
 *   - src/ops/tools/delegated-toolset.test.ts     — the belt chooser alone.
 *   - test/canonical-loop-runtime-surface-recovery.test.ts — rehydrate, but
 *       the registry + dispatcher are mocked.
 *
 * This test drives the REAL seam those units meet at: it runs the real
 * configureDelegatedRuntime against the live runtime singletons (real belt
 * chooser resolving the real unifiedRegistry, real surface builder, real MAC
 * seal, real in-process registration) and asserts the runtime the model
 * actually sees on turn 0, then proves the surface is MAC-durable by recovering
 * it after a simulated restart.
 *
 * ONLY the provider transport + credential resolution are faked — no real LLM,
 * no real provider account — mirroring how the canonical-loop suites mock the
 * provider hop. Every campaign-touched module runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Audience, ToolDefinition } from "../src/types.js";
import type { Op } from "../src/ops/types.js";

// Deterministic HMAC seed for sealDelegatedRuntime → verifyDelegatedRuntimeIntegrity
// so the seal round-trips without touching the OS keychain.
process.env.LAX_AUDIT_KEY = process.env.LAX_AUDIT_KEY ?? "a".repeat(64);

// A real workspace dir for the real SecurityLayer construction inside
// configureDelegatedRuntime (and its identical reconstruction on recovery).
const workspaceDir = mkdtempSync(join(tmpdir(), "delegated-e2e-ws-"));

// ── Mocks: the provider hop ONLY ────────────────────────────────────────────
// resolveProvider + resolveProviderRuntime + createProviderAdapterFactory are
// the only things that would touch a provider account / LLM. Everything the fix
// added — the belt chooser, buildAgentRuntimeSurface, sealDelegatedRuntime,
// installOpToolRuntime, and the runtime.js singletons they register into —
// runs for real.
vi.mock("../src/agent-request/resolve-provider.js", () => ({
  resolveProvider: async () => ({
    provider: "local",
    model: "nondefault-local-model",
    apiKey: "ollama",
    authSource: "sentinel",
  }),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    getRuntimeConfig: () => ({ ...actual.getRuntimeConfig(), workspace: workspaceDir }),
  };
});

vi.mock("../src/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/secrets.js")>();
  return { ...actual, getOrInitSecretsStore: () => ({}) };
});

// Keep sealDelegatedRuntime + registerAdapterForOp REAL (they carry the MAC and
// register into the live opAdapters map the recovery seam reads); fake only the
// two provider-runtime functions shared.ts pulls from this barrel.
vi.mock("../src/canonical-loop/public/delegated-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/canonical-loop/public/delegated-runtime.js")>();
  return {
    ...actual,
    resolveProviderRuntime: async () => ({
      identity: {
        provider: "local",
        credentialProvider: "local",
        authSource: "sentinel",
        model: "nondefault-local-model",
        runtime: "openai-compat",
        target: { kind: "local-config", endpointFingerprint: "1".repeat(64) },
      },
      apiKey: "resolved-target-key",
    }),
    createProviderAdapterFactory: async () => async () => ({
      name: "fake-adapter",
      version: "1",
      async runTurn() {
        return {
          providerState: { adapterName: "fake-adapter", adapterVersion: "1", providerPayload: null },
          terminalReason: "done" as const,
        };
      },
      async abort() {},
    }),
  };
});

// Real modules — the seams under test.
import { configureDelegatedRuntime } from "../src/ops/tools/shared.js";
import {
  getToolsForOp,
  getToolDispatcher,
  rehydrateRecoveredRuntime,
  resetCanonicalRuntime,
} from "../src/canonical-loop/runtime.js";
import { rehydrateAgentRuntimeSurface } from "../src/canonical-loop/agent-runner/runtime-surface.js";
import { verifyDelegatedRuntimeIntegrity } from "../src/canonical-loop/runtime-integrity.js";
import { buildTurnInput } from "../src/canonical-loop/turn-loop/build-input.js";
import { NotConfiguredToolDispatcher } from "../src/canonical-loop/tool-dispatch.js";
import { unifiedRegistry } from "../src/tools/registry.js";
import { writeOp } from "../src/ops/op-store.js";
import { DELEGATED_WORKER_PROMPT } from "../src/server/background-jobs/prompts.js";

const SESSION_ID = "session-delegated-e2e";

// The read/search belt a delegated worker should carry (subset asserted for
// presence) and the recursion/mutation vectors that must never survive the
// subtraction. Registered directly into the live unifiedRegistry so the real
// delegatedToolsetForOp resolves exactly what this test declares — same
// approach as src/ops/tools/delegated-toolset.test.ts.
const BELT = ["read", "glob", "grep", "web_search", "web_fetch", "tool_search", "view_image"];
const MUST_CONTAIN = ["read", "web_search", "tool_search"];
const DENIED = ["op_submit", "op_submit_async", "agent_spawn", "write", "edit", "bash", "mission_schedule_create"];

const registered: string[] = [];
let seq = 0;
let priorDataDir: string | undefined;
let dataDir: string;

function mkTool(name: string, audiences: Audience[] = ["spawned-agent"]): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "ok" }),
    audiences,
  };
}

function makeDelegatedOp(): Op {
  return {
    id: `op_research_${seq++}`,
    type: "research_query",
    task: "summarize the auth module",
    lane: "interactive",
    attemptCount: 0,
    status: "pending",
    ownerId: "local-user",
    visibility: "private",
    createdAt: new Date().toISOString(),
    retryPolicy: { maxRecoveryAttempts: 2, backoffMs: [1] },
    model: "nondefault-local-model",
    contextPack: { routing: { lane: "interactive", preferredProvider: "local" } },
    // canonical.sessionId must equal the sealed descriptor's sessionId for the
    // recovery identity check (runtime.ts rehydrateRecoveredRuntime) to pass.
    canonical: { sessionId: SESSION_ID, state: "queued", flagValue: true },
  } as unknown as Op;
}

beforeEach(() => {
  priorDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "delegated-e2e-data-"));
  process.env.LAX_DATA_DIR = dataDir;
  resetCanonicalRuntime();
  // Registry-first: the belt tools must exist in the one source of truth before
  // the surface is built AND before it is recovered — the same buildToolRegistry
  // -first ordering the runtime-surface recovery test relies on (rehydrate
  // re-resolves each tool from unifiedRegistry and re-checks its fingerprint).
  for (const name of [...BELT, ...DENIED]) {
    unifiedRegistry.register(mkTool(name));
    registered.push(name);
  }
});

afterEach(() => {
  resetCanonicalRuntime();
  for (const name of registered.splice(0)) unifiedRegistry.unregister(name);
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("delegated-worker toolset — end-to-end integration seam", () => {
  it("registers the real read/search belt (and none of the recursion/mutation vectors) for a spawned op", async () => {
    const op = makeDelegatedOp();
    await configureDelegatedRuntime(op, SESSION_ID);

    // #1 — getToolsForOp is the exact production line the turn loop reads
    // (build-input.ts:87). Post-fix it is non-empty and holds the belt.
    const names = getToolsForOp(op.id).map(t => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const t of MUST_CONTAIN) expect(names).toContain(t);
    for (const t of DENIED) expect(names).not.toContain(t);
  });

  it("delivers that same belt to the model on turn 0 through the real buildTurnInput", async () => {
    const op = makeDelegatedOp();
    await configureDelegatedRuntime(op, SESSION_ID);
    writeOp(op); // create the op dir so the store reads inside buildTurnInput return cleanly

    // #2 — TurnInput.tools is what the adapter actually tells the model about.
    // Driving the REAL buildTurnInput (no LLM — empty history, local model)
    // proves the getToolsForOp registration reaches the model's turn-0 surface,
    // closing the loop from spawn-time registration to the wire.
    const input = await buildTurnInput(op, 0, null);
    const turnToolNames = input.tools.map(t => t.name);
    for (const t of MUST_CONTAIN) expect(turnToolNames).toContain(t);
    for (const t of DENIED) expect(turnToolNames).not.toContain(t);
    // The two ends of the seam agree: what's registered == what the model sees.
    expect(turnToolNames.sort()).toEqual(getToolsForOp(op.id).map(t => t.name).sort());
  });

  it("seals a valid delegated agent-runner surface inside the descriptor MAC", async () => {
    const op = makeDelegatedOp();
    await configureDelegatedRuntime(op, SESSION_ID);

    // #3 — the descriptor is a valid sealed surface.
    expect(() => verifyDelegatedRuntimeIntegrity(op)).not.toThrow();
    const descriptor = op.runtimeDescriptor;
    expect(descriptor?.kind).toBe("delegated-op");
    const surface = descriptor?.kind === "delegated-op" ? descriptor.surface : undefined;
    expect(surface?.kind).toBe("agent-runner");
    expect(surface?.systemPrompt).toBe(DELEGATED_WORKER_PROMPT);
    expect(surface?.callContext).toBe("delegated");
    // The belt is sealed INSIDE the MAC (durable across restart / process worker).
    const surfaceToolNames = (surface?.tools ?? []).map(t => t.name);
    for (const t of MUST_CONTAIN) expect(surfaceToolNames).toContain(t);
    for (const t of DENIED) expect(surfaceToolNames).not.toContain(t);
  });

  it("registers a real per-op tool dispatcher (not the NotConfigured module global)", async () => {
    const op = makeDelegatedOp();
    await configureDelegatedRuntime(op, SESSION_ID);

    // #4 — before the fix EVERY tool call fell through to the module-global
    // NotConfiguredToolDispatcher and errored. Assert a real per-op dispatcher
    // is registered. (Executing a tool would require the full security/policy
    // execution scaffold; dispatcher IDENTITY is the pre-fix regression this
    // seam guards — a real dispatch is exercised by the chat-tool-dispatcher
    // unit suites.)
    const dispatcher = getToolDispatcher(op.id);
    expect(dispatcher).not.toBeInstanceOf(NotConfiguredToolDispatcher);
    // The global (no opId) is still the NotConfigured default after reset —
    // proving the op got its OWN dispatcher, not a shared global.
    expect(getToolDispatcher()).toBeInstanceOf(NotConfiguredToolDispatcher);
    expect(dispatcher).not.toBe(getToolDispatcher());
  });

  it("survives a simulated restart: the MAC-sealed surface rebuilds the belt + dispatcher", async () => {
    const op = makeDelegatedOp();
    await configureDelegatedRuntime(op, SESSION_ID);
    const beltAtSpawn = getToolsForOp(op.id).map(t => t.name).sort();
    expect(beltAtSpawn.length).toBeGreaterThan(0);

    // Simulate the process restart / process-worker relaunch: the durable
    // descriptor persists on the op, but every in-memory registration dies.
    resetCanonicalRuntime();
    expect(getToolsForOp(op.id)).toEqual([]);
    expect(getToolDispatcher(op.id)).toBeInstanceOf(NotConfiguredToolDispatcher);

    // #5a — the durable descriptor is accepted as reconstructible: identity +
    // MAC validate and a recovered adapter factory is registered (the exact
    // gate the OP-4 lost-registration suite exercises).
    expect(rehydrateRecoveredRuntime(op)).toBe(true);

    // #5b — rehydrateAgentRuntimeSurface is the exact entry the recovered
    // adapter factory invokes (runtime-reconstruction.ts:33-34) and the entry
    // the runtime-surface recovery suite drives directly. Rebuilding from the
    // sealed surface restores the belt + a real dispatcher from disk state
    // alone — the durability property the fix added.
    const surface = op.runtimeDescriptor?.kind === "delegated-op" ? op.runtimeDescriptor.surface : undefined;
    expect(surface).toBeTruthy();
    const rebuiltPrompt = rehydrateAgentRuntimeSurface(op, surface!);
    expect(rebuiltPrompt).toBe(DELEGATED_WORKER_PROMPT);
    expect(getToolsForOp(op.id).map(t => t.name).sort()).toEqual(beltAtSpawn);
    expect(getToolDispatcher(op.id)).not.toBeInstanceOf(NotConfiguredToolDispatcher);
  });
});
