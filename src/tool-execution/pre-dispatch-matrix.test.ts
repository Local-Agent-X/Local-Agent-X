import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertToolCallAllowed,
  ToolBlocked,
  type PreDispatchCtx,
  type ToolCallShape,
  type ToolBlockedStage,
} from "./pre-dispatch.js";
import type { PreDispatchDeps, PreDispatchRuntimeFlags } from "./pre-dispatch-deps.js";
import { localOnlyToolDecision, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";
import { RBACManager } from "../rbac.js";
import { ThreatEngine } from "../threat/threat-engine.js";
import { ToolPolicy } from "../tool-policy/index.js";
import type { RulePack } from "../tool-policy/evaluator.js";

// ── Table-driven veto matrix ────────────────────────────────────────────────
// (tool, situation) → allowed | blocked(stage) | approval-required, driven
// ENTIRELY through PreDispatchCtx (injected deps + the existing injected
// gates) — no vi.mock of modules anywhere. Every singleton the gate chain
// reads (runtime-config kill-switches, local-only policy, instruction
// ledger / plan mode, autonomy profile, approval manager, singleton-backed
// packs, session policy) is overridden per row, so each row pins WHICH stage
// vetoes and with WHAT disposition — not just a boolean.
//
// Complements pre-dispatch.test.ts, which drives the REAL singletons
// (setRuntimeConfig / setOpLedger / setEnforcedPlanMode) end-to-end; this
// file proves the same stages fire from injected state alone.

const ALL_ON: PreDispatchRuntimeFlags = {
  localOnlyMode: false,
  enableShell: true,
  enableHttp: true,
  enableBrowser: true,
  enableComputerControl: true,
  // Autonomous-by-default: supervision is OFF, so the browser.evaluate gate
  // never fires for these rows.
  supervisedBrowser: false,
};

function flags(over: Partial<PreDispatchRuntimeFlags> = {}): PreDispatchRuntimeFlags {
  return { ...ALL_ON, ...over };
}

function allowPack(id: string, priority: number): RulePack {
  return { id, priority, rules: [], evaluate: () => ({ allowed: true }) };
}

function denyPack(id: string, priority: number, reason: string): RulePack {
  return { id, priority, rules: [], evaluate: () => ({ allowed: false, reason }) };
}

/** Permissive baseline: every injectable singleton read says "fine". Rows
 *  override exactly the seam under test. hasCapability is left at its real
 *  default deliberately — capability classes are static registry data. */
function baseDeps(): PreDispatchDeps {
  return {
    checkSessionPolicy: () => null,
    getRuntimeConfig: () => flags(),
    localOnlyToolDecision: () => ({ allowed: true }),
    opForbidsCapability: () => false,
    planModeForbidsCapability: () => false,
    makeSpendCapPack: () => allowPack("spend-cap", 5),
    makeEgressRefutationPack: () => allowPack("egress-refutation", 50),
    getToolDecision: () => "allow",
    getRiskDecision: () => "allow",
  };
}

type RowExpect =
  | { outcome: "allowed" }
  | { outcome: "approval-required" }
  | {
      outcome: "blocked";
      stage: ToolBlockedStage;
      disposition?: "hard-deny" | "approval-required";
      reason?: RegExp;
    };

interface MatrixRow {
  name: string;
  call: ToolCallShape;
  deps?: PreDispatchDeps;
  ctx?: Partial<Omit<PreDispatchCtx, "deps">>;
  expected: RowExpect;
}

// Real instances for the two gates whose ctx slots take class types: a real
// RBACManager (readonly role has an empty tool allowlist) and a real
// ThreatEngine latched into restricted mode via a confirmed-breach event.
let tmpRoot: string;
let rbac: RBACManager;
let restrictedThreat: ThreatEngine;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pre-dispatch-matrix-"));
  rbac = new RBACManager(join(tmpRoot, "rbac"), "matrix-operator-token");
  restrictedThreat = new ThreatEngine(join(tmpRoot, "threat"), "matrix-threat-sess");
  restrictedThreat.scorer.record("canary_tripped", 100, "matrix: confirmed breach latch");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const planModeForbidsWrites = (_sessionId: string, cls: string): boolean =>
  cls === "workspace-write";

const rows: MatrixRow[] = [
  {
    name: "baseline: read with every gate permissive → allowed",
    call: { id: "m-base", name: "read", args: { path: "a.txt" } },
    expected: { outcome: "allowed" },
  },
  {
    name: "shell kill-switch off → bash blocked at tool-policy (kill-switch)",
    call: { id: "m-sh", name: "bash", args: { command: "ls" } },
    deps: { getRuntimeConfig: () => flags({ enableShell: false }) },
    expected: { outcome: "blocked", stage: "tool-policy", reason: /Shell Access is disabled/ },
  },
  {
    name: "shell kill-switch covers the process_* family, not just bash",
    call: { id: "m-proc", name: "process_start", args: { command: "node server.js" } },
    deps: { getRuntimeConfig: () => flags({ enableShell: false }) },
    expected: { outcome: "blocked", stage: "tool-policy", reason: /Shell Access is disabled/ },
  },
  {
    name: "http kill-switch off → http_request blocked at tool-policy (kill-switch)",
    call: { id: "m-http", name: "http_request", args: { url: "https://example.com" } },
    deps: { getRuntimeConfig: () => flags({ enableHttp: false }) },
    expected: { outcome: "blocked", stage: "tool-policy", reason: /HTTP Requests are disabled/ },
  },
  {
    name: "strict local-only mode → non-loopback network tool blocked (real policy fn, injected cfg)",
    call: { id: "m-lo", name: "http_request", args: { url: "https://example.com" } },
    deps: {
      getRuntimeConfig: () => flags({ localOnlyMode: true }),
      localOnlyToolDecision,
    },
    expected: {
      outcome: "blocked",
      stage: "tool-policy",
      reason: new RegExp(LOCAL_ONLY_BLOCK_MESSAGE.slice(0, 35)),
    },
  },
  {
    name: "strict local-only mode → loopback URL still allowed",
    call: { id: "m-lo-ok", name: "http_request", args: { url: "http://127.0.0.1:7007/health" } },
    deps: {
      getRuntimeConfig: () => flags({ localOnlyMode: true }),
      localOnlyToolDecision,
    },
    expected: { outcome: "allowed" },
  },
  {
    name: "RBAC: readonly role cannot call write → blocked at rbac",
    call: { id: "m-rbac", name: "write", args: { path: "a.txt", content: "x" } },
    ctx: { rbac: { get manager() { return rbac; }, role: "readonly" } },
    expected: { outcome: "blocked", stage: "rbac", reason: /cannot use tool/ },
  },
  {
    name: "enforced plan mode → mutation tool hard-denied at tool-policy",
    call: { id: "m-plan", name: "write", args: { path: "a.txt", content: "x" } },
    deps: { planModeForbidsCapability: planModeForbidsWrites },
    expected: {
      outcome: "blocked",
      stage: "tool-policy",
      disposition: "hard-deny",
      reason: /Enforced plan mode/,
    },
  },
  {
    name: "enforced plan mode, shell-write escape hatch → mutating bash blocked",
    call: { id: "m-plan-sh", name: "bash", args: { command: "sed -i 's/a/b/' src/x.ts" } },
    deps: { planModeForbidsCapability: planModeForbidsWrites },
    expected: {
      outcome: "blocked",
      stage: "tool-policy",
      disposition: "hard-deny",
      reason: /writes to the filesystem/,
    },
  },
  {
    name: "enforced plan mode, shell escape hatch → read-only bash still allowed",
    call: { id: "m-plan-ro", name: "bash", args: { command: "grep -rn foo src" } },
    deps: { planModeForbidsCapability: planModeForbidsWrites },
    expected: { outcome: "allowed" },
  },
  {
    name: "op-ledger prohibition → edit hard-denied with the user-stated wording",
    call: { id: "m-op", name: "edit", args: { path: "a.txt" } },
    deps: {
      opForbidsCapability: (opId, cls) => opId === "op-matrix" && cls === "workspace-write",
    },
    ctx: { opId: "op-matrix" },
    expected: {
      outcome: "blocked",
      stage: "tool-policy",
      disposition: "hard-deny",
      reason: /The user asked you not to edit or write files/,
    },
  },
  {
    name: "spend-cap pack deny → blocked at tool-policy via the unified evaluator",
    call: { id: "m-spend", name: "read", args: { path: "a.txt" } },
    deps: {
      makeSpendCapPack: () =>
        denyPack("spend-cap", 5, "Daily spend ($5.00) has reached the configured budget ($5.00)."),
    },
    expected: { outcome: "blocked", stage: "tool-policy", reason: /Daily spend/ },
  },
  {
    name: "default-deny policy → unknown tool blocked at tool-policy",
    call: { id: "m-unk", name: "totally_unknown_tool", args: {} },
    ctx: { toolPolicy: new ToolPolicy({ defaultDecision: "deny", rules: [] }) },
    expected: { outcome: "blocked", stage: "tool-policy" },
  },
  {
    name: "threat engine restricted (confirmed breach) → external tool blocked at threat",
    call: { id: "m-threat", name: "http_request", args: { url: "https://example.com" } },
    ctx: { get threatEngine() { return restrictedThreat; } },
    expected: { outcome: "blocked", stage: "threat", reason: /threat level elevated/i },
  },
  {
    name: "autonomy profile says ask → approval requested, call proceeds once granted",
    call: { id: "m-ask", name: "write", args: { path: "a.txt", content: "x" } },
    deps: { getToolDecision: () => "ask" },
    ctx: { approval: { onEvent: () => {} } },
    expected: { outcome: "approval-required" },
  },
  {
    name: "autonomy profile says deny → blocked at approval without prompting",
    call: { id: "m-deny", name: "write", args: { path: "a.txt", content: "x" } },
    deps: { getToolDecision: () => "deny" },
    ctx: { approval: { onEvent: () => {} } },
    expected: { outcome: "blocked", stage: "approval", reason: /BLOCKED by profile/ },
  },
  {
    name: "session policy veto → blocked at session-policy",
    call: { id: "m-sess", name: "read", args: { path: "a.txt" } },
    deps: { checkSessionPolicy: () => "This tool is disabled for the session" },
    expected: { outcome: "blocked", stage: "session-policy", reason: /disabled for the session/ },
  },
];

describe("pre-dispatch veto matrix — (tool, situation) → stage/disposition via injected deps", () => {
  for (const row of rows) {
    it(row.name, async () => {
      const prompts: Array<{ toolName: string; alwaysAsk: boolean }> = [];
      const deps: PreDispatchDeps = {
        ...baseDeps(),
        getApprovalManager: () => ({
          requestApproval: async (opts) => {
            prompts.push({ toolName: opts.toolName, alwaysAsk: opts.alwaysAsk });
            return true;
          },
        }),
        ...row.deps,
      };
      const ctx: PreDispatchCtx = {
        sessionId: "matrix-sess",
        callContext: "local",
        ...row.ctx,
        deps,
      };

      let blocked: ToolBlocked | null = null;
      try {
        await assertToolCallAllowed(row.call, ctx);
      } catch (e) {
        if (!(e instanceof ToolBlocked)) throw e;
        blocked = e;
      }

      const exp = row.expected;
      if (exp.outcome === "allowed") {
        expect(blocked).toBeNull();
        expect(prompts).toHaveLength(0);
      } else if (exp.outcome === "approval-required") {
        // The profile demanded a prompt; the injected manager granted it, so
        // the call resolves — the disposition under test is "prompt happened".
        expect(blocked).toBeNull();
        expect(prompts).toHaveLength(1);
        expect(prompts[0].toolName).toBe(row.call.name);
        expect(prompts[0].alwaysAsk).toBe(false);
      } else {
        expect(blocked).not.toBeNull();
        expect(blocked?.stage).toBe(exp.stage);
        expect(blocked?.disposition).toBe(exp.disposition ?? "hard-deny");
        if (exp.reason) expect(blocked?.reason).toMatch(exp.reason);
        expect(prompts).toHaveLength(0);
      }
    });
  }
});
