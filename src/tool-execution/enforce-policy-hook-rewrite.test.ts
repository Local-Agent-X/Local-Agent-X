import { describe, it, expect, vi, beforeEach } from "vitest";

// Neutralize every gate except the ones under test (hook phase + the
// re-screened validation/security chain), so the test proves ORDERING:
// a PreToolUse rewrite must re-run pre-dispatch + schema validation on the
// NEW args before anything executes.
vi.mock("../ari-kernel/index.js", () => ({
  shouldGateInKernel: vi.fn(() => false),
  shouldObserveInKernel: vi.fn(() => false),
  isAriActive: vi.fn(() => false),
  ariEvaluate: vi.fn(),
  ariObserve: vi.fn(),
}));
vi.mock("../session/policy.js", () => ({ checkSessionPolicy: vi.fn(() => null) }));
vi.mock("../data-lineage/index.js", () => ({ getKernelTaintSources: vi.fn(() => []) }));
vi.mock("../tool-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-registry.js")>();
  return { ...actual, WORKTREE_PATH_TOOLS: new Set(), hasCapability: vi.fn(() => false) };
});
vi.mock("./ari-action-map.js", () => ({ ARI_ACTION_MAP: {}, deriveAriAction: vi.fn(() => "read") }));
vi.mock("./egress-gates.js", () => ({
  egressAggregateGate: vi.fn(() => ({ kind: "continue" })),
  egressGuardGate: vi.fn(),
  dataLineageGate: vi.fn(),
  canaryEgressGate: vi.fn(),
}));
vi.mock("./private-content-gate.js", () => ({ privateContentGate: vi.fn(async () => ({ kind: "continue" })) }));
vi.mock("./pre-dispatch.js", () => ({ assertToolCallAllowed: vi.fn(async () => {}) }));
vi.mock("../circuit-breaker.js", () => ({
  checkCircuit: vi.fn(() => ({ allowed: true })),
  circuitArgsSig: vi.fn(() => "sig"),
}));
vi.mock("./rate-limiter.js", () => ({ checkToolRateLimit: vi.fn(() => ({ allowed: true })) }));
vi.mock("../retry-telemetry.js", () => ({ logRetry: vi.fn() }));
vi.mock("../hooks/hook-engine.js", () => ({ getHookEngine: vi.fn() }));

import { enforcePolicyPhase } from "./enforce-policy.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { assertToolCallAllowed } from "./pre-dispatch.js";
import type { ToolCallContext } from "./context.js";

const TOOL = {
  name: "write",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path"],
  },
};

function ctxFor(args: Record<string, unknown>): ToolCallContext {
  return {
    tc: { id: "t1", name: "write", arguments: JSON.stringify(args) },
    toolMap: new Map([["write", TOOL]]),
    security: { evaluate: () => ({ allowed: true, reason: "" }) },
    sessionId: "s1",
    callContext: "local",
    args: { ...args },
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;
}

function hookEngineReturning(fire: ReturnType<typeof vi.fn>, hasHooks = true): void {
  (getHookEngine as ReturnType<typeof vi.fn>).mockReturnValue({ hasHooks, fire });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PreToolUse arg rewrite — applied and re-screened", () => {
  it("applies a hook rewrite and re-runs the security chain on the NEW args", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true, rewriteArgs: { path: "redirected.txt", content: "x" } })));
    const ctx = ctxFor({ path: "original.txt", content: "x" });

    const outcome = await enforcePolicyPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.args).toEqual({ path: "redirected.txt", content: "x" });
    // Pre-dispatch (security/rbac/tool-policy) judged BOTH calls: the original
    // args once, then the rewritten args from scratch.
    const calls = (assertToolCallAllowed as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].args).toEqual({ path: "original.txt", content: "x" });
    expect(calls[1][0].args).toEqual({ path: "redirected.txt", content: "x" });
  });

  it("a rewrite that breaks the tool's schema is caught by the re-screen, not executed", async () => {
    // Drops the REQUIRED field — a violation arg-coercion cannot repair.
    hookEngineReturning(vi.fn(async () => ({ continue: true, rewriteArgs: { content: "x" } })));
    const ctx = ctxFor({ path: "original.txt" });

    const outcome = await enforcePolicyPhase(ctx);

    // validateArgs re-ran on the rewritten args and terminated the call.
    expect(outcome.kind).not.toBe("continue");
    expect(ctx.allowed).toBe(false);
  });

  it("no rewrite → single gate pass, args untouched", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true })));
    const ctx = ctxFor({ path: "original.txt" });

    const outcome = await enforcePolicyPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.args).toEqual({ path: "original.txt" });
    expect((assertToolCallAllowed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("a write to a file the app acts on leaves an approval reason for the approval phase", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true })));
    const ctx = ctxFor({ path: "~/.lax/mcp.json", content: "{}" });

    expect((await enforcePolicyPhase(ctx)).kind).toBe("continue");
    expect(ctx.policyApprovalReason).toContain("This write call changes ~/.lax/mcp.json");
  });

  it("a rewrite that redirects a write onto such a file is caught by the re-screen", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true, rewriteArgs: { path: "~/.lax/hooks.json", content: "x" } })));
    const ctx = ctxFor({ path: "notes.txt", content: "x" });

    expect((await enforcePolicyPhase(ctx)).kind).toBe("continue");
    expect(ctx.policyApprovalReason).toContain("This write call changes ~/.lax/hooks.json");
  });

  it("a blocking hook still blocks (rewrite support does not weaken the veto)", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: false, reason: "policy says no" })));
    const ctx = ctxFor({ path: "original.txt" });

    const outcome = await enforcePolicyPhase(ctx);

    expect(outcome.kind).not.toBe("continue");
    expect(ctx.result?.content).toContain("policy says no");
  });
});

// Arg repair renames a key the model's chat template leaked into, and coercion
// changes a value's type (arg-repair.ts). Run after the gates, the gates judged
// one call and the tool ran another: this path was no path at all to the
// file-access and control-file gates, then became `path` and was written.
const LEAKED_PATH_KEY = 'write<|message|><atem:parameter name="path';

function preDispatchArgs(call: number): unknown {
  return (assertToolCallAllowed as ReturnType<typeof vi.fn>).mock.calls[call][0].args;
}

describe("the gates judge the args the tool runs with", () => {
  it("a write whose path key only exists after repair is judged at that path", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true })));
    const ctx = ctxFor({ [LEAKED_PATH_KEY]: "~/.lax/hooks.json", content: "x" });

    expect((await enforcePolicyPhase(ctx)).kind).toBe("continue");
    expect(ctx.args).toEqual({ path: "~/.lax/hooks.json", content: "x" });
    expect(ctx.policyApprovalReason).toContain("This write call changes ~/.lax/hooks.json");
    expect(preDispatchArgs(0)).toEqual(ctx.args);
  });

  it("a hook rewrite is repaired before the re-screen judges it", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true, rewriteArgs: { [LEAKED_PATH_KEY]: "~/.lax/hooks.json", content: "x" } })));
    const ctx = ctxFor({ path: "notes.txt", content: "x" });

    expect((await enforcePolicyPhase(ctx)).kind).toBe("continue");
    expect(ctx.args).toEqual({ path: "~/.lax/hooks.json", content: "x" });
    expect(ctx.policyApprovalReason).toContain("This write call changes ~/.lax/hooks.json");
    expect(preDispatchArgs(1)).toEqual(ctx.args);
  });

  it("a coerced value reaches the gates in the type the tool receives", async () => {
    hookEngineReturning(vi.fn(async () => ({ continue: true })));
    const ctx = ctxFor({ path: "notes.txt", content: 42 });

    expect((await enforcePolicyPhase(ctx)).kind).toBe("continue");
    expect(ctx.args).toEqual({ path: "notes.txt", content: "42" });
    expect(preDispatchArgs(0)).toEqual(ctx.args);
  });
});
