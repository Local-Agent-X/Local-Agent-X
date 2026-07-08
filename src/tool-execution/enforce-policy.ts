// Policy phase: AriKernel gate, session policy, worktree path rewrite,
// shared pre-dispatch chain (security/rbac/tool-policy), data-lineage egress,
// tool lookup, arg coercion + schema validation, PreToolUse hook, circuit
// breaker, rate limit. Sets ctx.preBlocked on pre-dispatch / unknown-tool
// failures (those flow through to audit); terminates outright on every
// other policy failure.

import { USER_HINTS, type ToolResult } from "../types.js";
import { ariEvaluate, ariObserve, isAriActive, shouldGateInKernel, shouldObserveInKernel } from "../ari-kernel/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import { getKernelTaintSources } from "../data-lineage.js";
import { WORKTREE_PATH_TOOLS, hasCapability } from "../tool-registry.js";
import { taintedShellBlockReason, blockedSelfVerifyGuidance } from "./shell-block-guidance.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import { checkCircuit, circuitArgsSig } from "../circuit-breaker.js";
import { checkToolRateLimit } from "./rate-limiter.js";
import { logRetry } from "../retry-telemetry.js";
import { assertToolCallAllowed } from "../tools/pre-dispatch.js";
import { ToolBlocked } from "./errors.js";
import { join, resolve, relative } from "node:path";
import type { Phase, PhaseOutcome, ToolCallContext } from "./context.js";
import { terminate, CONTINUE, BLOCK } from "./context.js";
import { egressAggregateGate, type EgressBlocker } from "./egress-gates.js";

export { egressGuardGate, dataLineageGate, canaryEgressGate } from "./egress-gates.js";
// Tool lookup + arg validation live in arg-validation.ts (LOC ceiling);
// re-exported so the corrections tests keep their enforce-policy imports.
export { formatUnknownToolCorrection, collectArgViolations } from "./arg-validation.js";
import { lookupTool, validateArgs } from "./arg-validation.js";
// ARI action derivation lives in its own module (source-hygiene LOC ceiling);
// re-exported here so resolve-tool.ts + the ari-action-map / td11 tests keep
// their `from "./enforce-policy.js"` imports.
export { ARI_ACTION_MAP, deriveAriAction } from "./ari-action-map.js";
import { deriveAriAction } from "./ari-action-map.js";

// Side-effect-free "what-else-would-block" probe of the gates a kernel-denied
// egress request would traverse NEXT in the pre-dispatch chain, so their
// verdicts join the same aggregate (SC-10). Only the SECURITY layer is probed:
// SecurityLayer.evaluate is a pure decision function. The threat-engine pack is
// deliberately NOT probed here — runPreDispatch never passes a threatEngine to
// assertToolCallAllowed (it is inert in this path), so surfacing a threat block
// the path won't actually enforce would be a phantom blocker. The data-lineage /
// canary / egress-guard cohort is probed by egressAggregateGate itself.
function probeUpstreamEgressBlockers(ctx: ToolCallContext): EgressBlocker[] {
  const out: EgressBlocker[] = [];
  const sec = ctx.security?.evaluate({
    toolName: ctx.tc.name,
    args: ctx.args,
    sessionId: ctx.sessionId || "default",
    callContext: ctx.callContext,
  });
  if (sec && !sec.allowed) {
    out.push({
      layer: "security",
      label: "security",
      reason: sec.reason,
      recovery:
        "Adjust the call to stay within the workspace and security boundaries — retrying the same args will be denied again.",
      userHint: sec.userHint ?? USER_HINTS.policy,
    });
  }
  return out;
}

async function ariKernelGate(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId } = ctx;
  const ariScopeId = ctx.operationId ?? ctx.runId;
  if (shouldGateInKernel(tc.name)) {
    // Every gated tool goes through the single ARI decision. ariEvaluate
    // fail-closes when the kernel is required but inactive (firewall === null
    // && ariRequired), so an ARI that failed to start can't silently leave
    // gated I/O ungated — it blocks. Guarding this branch on isAriActive()
    // (as it once did) made that fail-closed path unreachable: an inactive
    // kernel skipped the gate entirely.
    // Feed the live session's taint (recorded by data-lineage when a
    // sensitive/web/rag read occurred) into the kernel as the 4th arg, so the
    // kernel's behavioral deny-tainted-shell / deny-tainted-http rules actually
    // fire. Without this the kernel always saw empty taint and those rules were
    // dead code. The MODEL can't supply taint — it comes from the trusted
    // runtime tracker keyed off the session id.
    const taintLabels = getKernelTaintSources(sessionId || "default");
    // Tainted-shell pre-gate: deny here, BEFORE ariEvaluate, so the kernel never
    // observes a taint+shell event and quarantines the run (which would also
    // block file writes for the rest of this op). Shell stays denied; editing
    // keeps working. See taintedShellBlockReason for the full rationale.
    const shellTaintBlock = taintedShellBlockReason(tc.name, taintLabels);
    if (shellTaintBlock) {
      return terminate(ctx, { rendered: "raw", content: `User hint: ${USER_HINTS.policy}\n${shellTaintBlock}`, allowed: false });
    }
    const ariResult = await ariEvaluate(tc.name, deriveAriAction(tc.name, args), args, taintLabels, ariScopeId);
    if (!ariResult.allowed) {
      const hint = ariResult.userHint ?? USER_HINTS.policy;
      // SC-10: an egress-class tool denied at the KERNEL (e.g. TD-11 derives a
      // tainted POST → action="post" → deny-tainted-http-write) must not
      // short-circuit with ONLY the kernel reason and leave the model chasing
      // one blocker per turn (fix the taint → retry → hit the host-allowlist →
      // …). Aggregate the kernel verdict with the downstream egress blockers it
      // would ALSO hit — security layer + data-lineage + canary + egress-guard —
      // probed side-effect-free, into ONE response tagged per authoritative
      // layer. Enforcement is unchanged (still blocks); only the reported reason
      // becomes the aggregate. Non-egress kernel denials keep the raw message.
      if (hasCapability(tc.name, "egress")) {
        const kernelBlocker: EgressBlocker = {
          layer: "arikernel",
          label: "ARI kernel",
          reason: ariResult.reason,
          recovery:
            "The kernel policy denies this outbound action (typically an untrusted-input taint on an http/browser write). Declassify the taint or end the session — do not just retry the same call.",
          userHint: hint,
        };
        return egressAggregateGate(ctx, [kernelBlocker, ...probeUpstreamEgressBlockers(ctx)]);
      }
      return terminate(ctx, { rendered: "raw", content: `User hint: ${hint}\n${ariResult.reason}`, allowed: false });
    }
  } else if (isAriActive() && shouldObserveInKernel(tc.name)) {
    // Audit-only path for internal-class tools — never blocks.
    ariObserve(tc.name, "internal", args, { sessionId, scopeId: ariScopeId });
  }
  return CONTINUE;
}

function sessionPolicyGate(ctx: ToolCallContext): PhaseOutcome {
  const block = checkSessionPolicy(ctx.sessionId || "default", ctx.tc.name);
  if (block) {
    return terminate(ctx, { rendered: "raw", content: `User hint: ${USER_HINTS.policy}\n${block}`, allowed: false });
  }
  return CONTINUE;
}

// Worktree enforcement: rewrite paths BEFORE the security pre-dispatch
// chain so security evaluates the actual path.
async function rewriteWorktreePaths(ctx: ToolCallContext): Promise<void> {
  const { tc, args, sessionId } = ctx;
  if (!sessionId?.startsWith("agent-")) return;
  try {
    const agentId = sessionId.slice(6);
    const { getWorktreePath } = await import("../agency/worktree.js");
    const wtPath = getWorktreePath(agentId);
    if (!wtPath) return;
    if (WORKTREE_PATH_TOOLS.has(tc.name) && args.path) {
      const rawPath = String(args.path);
      const isAbsolute = rawPath.startsWith("/") || rawPath.includes(":");
      if (isAbsolute) {
        if (["glob", "grep", "structural_search"].includes(tc.name)) {
          const resolved = resolve(rawPath);
          if (relative(wtPath, resolved).startsWith("..")) {
            args.path = wtPath;
          }
        }
      } else {
        args.path = join(wtPath, rawPath);
      }
    }
    if (["glob", "grep", "structural_search"].includes(tc.name) && !args.path) {
      args.path = wtPath;
    }
    if (tc.name === "bash") args._cwd = wtPath;
  } catch { /* worktree module not available */ }
}

// Pre-dispatch chain blocks set ctx.result and return BLOCK. Audit still
// runs (so the block message can be re-examined by threat engine + hooks).
async function runPreDispatch(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, callContext, security, rbac, callerRole, toolPolicy, operationId } = ctx;
  try {
    await assertToolCallAllowed(
      { id: tc.id, name: tc.name, args },
      {
        sessionId: sessionId || "default",
        callContext,
        // Keys the per-op instruction-ledger prohibition gate; undefined for
        // non-op dispatches, which keeps that gate fail-open.
        opId: operationId,
        skipSessionPolicy: true,
        security,
        rbac: rbac && callerRole ? { manager: rbac, role: callerRole } : undefined,
        toolPolicy,
      },
    );
  } catch (e) {
    if (!(e instanceof ToolBlocked)) throw e;
    if (e.disposition === "approval-required") {
      ctx.policyApprovalReason = e.reason;
      return CONTINUE;
    }
    const layerMap: Record<typeof e.stage, string> = {
      "session-policy": "session-policy",
      "security": "security",
      "rbac": "rbac",
      "tool-policy": "tool-policy",
      "threat": "threat",
      "arikernel": "arikernel",
      "approval": "approval",
    };
    // A blocked verify-shaped shell command (running the project's build/type-check
    // on source) gets accurate guidance instead of the generic "find a safer way"
    // recovery, which otherwise sends the model hunting a nonexistent executor. The
    // orchestrator build-verify gate covers it — see build-verify.ts.
    const selfVerify = blockedSelfVerifyGuidance(ctx.tc.name, ctx.args);
    ctx.allowed = false;
    ctx.result = {
      content: e.message,
      isError: true,
      status: "blocked",
      metadata: {
        layer: layerMap[e.stage],
        recovery: selfVerify?.recovery ?? e.recovery,
        userHint: selfVerify?.userHint ?? e.userHint,
      },
    };
    return BLOCK;
  }
  return CONTINUE;
}

async function preToolUseHook(ctx: ToolCallContext): Promise<PhaseOutcome> {
  const { tc, args, sessionId, callContext } = ctx;
  const hookEngine = getHookEngine();
  if (!hookEngine.hasHooks) return CONTINUE;
  const preHook = await hookEngine.fire({ event: "PreToolUse", toolName: tc.name, toolArgs: args, sessionId, callContext });
  if (preHook.continue) {
    // A hook rewrote the args. Stash the rewrite — enforcePolicyPhase applies
    // it and re-runs the full security + validation chain on the NEW args, so
    // a rewrite can never smuggle a payload past a gate that only saw the
    // original call.
    if (preHook.rewriteArgs) ctx.hookRewrittenArgs = preHook.rewriteArgs;
    return CONTINUE;
  }
  const result: ToolResult = {
    content: `BLOCKED by hook: ${preHook.reason || "PreToolUse hook returned false"}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "hook", recovery: "A user-configured hook blocked this call. Check ~/.lax/hooks.json or proceed without the gated action.", userHint: USER_HINTS.policy },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

function circuitBreakerGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, sessionId } = ctx;
  const circuit = checkCircuit(sessionId, tc.name, circuitArgsSig(tc.arguments));
  if (circuit.allowed) return CONTINUE;
  const result: ToolResult = {
    content: `BLOCKED by circuit breaker: ${circuit.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "circuit-breaker", recovery: "This tool has failed repeatedly in this session. Stop calling it and use an alternative — the breaker will reset after several successful unrelated calls.", userHint: circuit.userHint ?? USER_HINTS.retryExhausted },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

function rateLimitGate(ctx: ToolCallContext): PhaseOutcome {
  const { tc, sessionId } = ctx;
  const rate = checkToolRateLimit(tc.name, sessionId);
  if (rate.allowed) {
    // A warn/throttle limit that's OVER its cap still allows the call, but the
    // warning must not be silently dropped (as it was — downgraded to a bare
    // allow): surface the reset-bearing reason so the model can self-throttle
    // instead of hammering the limit blind.
    if (rate.action !== "allow" && rate.reason) {
      ctx.onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message: `Rate-limit ${rate.action}: ${rate.reason}` });
    }
    return CONTINUE;
  }
  const resetSec = Math.ceil(Math.max(0, rate.resetInMs) / 1000);
  const result: ToolResult = {
    content: `BLOCKED by rate limit: ${rate.reason}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "rate-limit", recovery: `Per-tool rate limit hit — resets in ${resetSec}s. Wait for the reset window or pivot to another approach / batch fewer calls; immediate retries will keep being denied until then.`, userHint: rate.userHint ?? USER_HINTS.retryExhausted },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
}

/** Every gate that must judge the FINAL args, in order. Split out of
 *  enforcePolicyPhase so a PreToolUse hook rewrite can be re-screened by the
 *  exact same chain it already passed with the original args. The gates are
 *  evaluations (no committing side effects), so a second pass is safe; the
 *  counting gates (circuit breaker, rate limit) stay outside and run once. */
async function securityAndValidationGates(ctx: ToolCallContext): Promise<PhaseOutcome> {
  let outcome = await ariKernelGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  outcome = sessionPolicyGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  await rewriteWorktreePaths(ctx);

  outcome = await runPreDispatch(ctx);
  if (outcome.kind !== "continue") return outcome;
  // SC-10: the data-lineage + canary + egress-guard cohort is enforced as one
  // aggregated gate — a payload denied by more than one of them reports every
  // blocker together instead of one-per-turn. (When the KERNEL denied an egress
  // tool upstream, ariKernelGate already ran this aggregate with the kernel
  // verdict prepended and short-circuited before here.)
  outcome = egressAggregateGate(ctx);
  if (outcome.kind !== "continue") return outcome;

  outcome = lookupTool(ctx);
  if (outcome.kind !== "continue") return outcome;
  return validateArgs(ctx);
}

export const enforcePolicyPhase: Phase = async (ctx) => {
  let outcome = await securityAndValidationGates(ctx);
  if (outcome.kind !== "continue") return outcome;

  outcome = await preToolUseHook(ctx);
  if (outcome.kind !== "continue") return outcome;
  if (ctx.hookRewrittenArgs) {
    ctx.args = ctx.hookRewrittenArgs;
    ctx.hookRewrittenArgs = undefined;
    // Hooks are NOT re-fired on the second pass (the rewrite came from them;
    // re-firing would loop), but every security/validation gate re-judges the
    // rewritten args from scratch.
    outcome = await securityAndValidationGates(ctx);
    if (outcome.kind !== "continue") return outcome;
  }

  outcome = circuitBreakerGate(ctx);
  if (outcome.kind !== "continue") return outcome;
  return rateLimitGate(ctx);
};
