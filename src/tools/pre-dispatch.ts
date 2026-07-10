/**
 * Pre-dispatch gate chain — the checks every tool call must pass before
 * execution, regardless of which dispatcher routed it. Both the chat-path
 * (src/tool-executor.ts) and the AriKernel-path
 * (packages/arikernel/tool-executors/*) call this, closing F3 from DRY-AUDIT.md.
 *
 * Policy evaluation is unified through src/tool-policy/evaluator.ts (F4).
 * Four packs (security, default-policy, threat, arikernel) are evaluated in
 * one pass; session-policy / RBAC / approval remain per-user gates outside
 * the pack mechanism.
 */
import type { SecurityLayer } from "../security/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import {
  getApprovalManager,
  getToolDecision,
  getRiskDecision,
  decisionRequiresPrompt,
  decisionDenies,
  applyIrreversibleFloor,
  destructiveOperationReason,
} from "../approval-manager.js";
import { getRuntimeConfig } from "../config.js";
import { hasCapability, type CapabilityClass } from "../tool-registry.js";
import { opForbidsCapability, planModeForbidsCapability } from "../canonical-loop/instruction-ledger/index.js";
import { shellCommandWritesFiles } from "../security/shell-write-detector.js";
import { isProtectedSetting } from "../settings-schema.js";
import type { ServerEvent } from "../types.js";
import { USER_HINTS } from "../types.js";
import { evaluate as evaluatePolicy, type RulePack } from "../tool-policy/evaluator.js";
import { makeSpendCapPack } from "../tool-policy/packs/spend-cap-pack.js";
import { makeSecurityLayerPack } from "../tool-policy/packs/security-layer-pack.js";
import { makeDefaultPolicyPack } from "../tool-policy/packs/default-policy-pack.js";
import { makeThreatEnginePack } from "../tool-policy/packs/threat-engine-pack.js";
import { makeArikernelPack } from "../tool-policy/packs/arikernel-pack.js";
import { makeEgressRefutationPack } from "../tool-policy/packs/egress-refutation-pack.js";

export type ToolBlockedStage =
  | "session-policy"
  | "security"
  | "rbac"
  | "tool-policy"
  | "threat"
  | "arikernel"
  | "approval";

export class ToolBlocked extends Error {
  readonly stage: ToolBlockedStage;
  readonly disposition: "hard-deny" | "approval-required";
  readonly reason: string;
  readonly recovery?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  readonly userHint?: string;
  constructor(details: { stage: ToolBlockedStage; disposition?: "hard-deny" | "approval-required"; reason: string; recovery?: string; userHint?: string }) {
    const disposition = details.disposition ?? "hard-deny";
    super(`${disposition === "approval-required" ? "APPROVAL REQUIRED by" : "BLOCKED by"} ${details.stage}: ${details.reason}`);
    this.name = "ToolBlocked";
    this.stage = details.stage;
    this.disposition = disposition;
    this.reason = details.reason;
    this.recovery = details.recovery;
    this.userHint = details.userHint;
  }
}

export interface ToolCallShape {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface PreDispatchCtx {
  sessionId: string;
  callContext: "local" | "api" | "delegated" | "cron";
  /** Canonical op id — keys the per-op instruction ledger (user-stated run
   *  constraints, e.g. "don't edit any code"). Absent for non-op callers
   *  (ARI bridge, MCP, ad-hoc dispatches), which skips the op-prohibition
   *  gate entirely (fail-open). */
  opId?: string;
  skipSessionPolicy?: boolean;
  security?: SecurityLayer;
  rbac?: { manager: RBACManager; role: Role };
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  approval?: { onEvent: (event: ServerEvent) => void; context?: string };
}

/** One entry per capability class the instruction ledger can prohibit.
 *  `verb` phrases the user's restriction back to the model; `recovery` tells
 *  it how to proceed without the tool. A class without an entry simply isn't
 *  op-prohibitable at this gate. */
const OP_PROHIBITION_GUIDANCE: ReadonlyArray<{ cls: CapabilityClass; verb: string; recovery: string }> = [
  { cls: "workspace-write", verb: "edit or write files", recovery: "Propose the change in your reply (e.g. as a diff or step-by-step instructions) instead of modifying files." },
  { cls: "egress", verb: "browse or send data over the network", recovery: "Work from local files and what is already in context; don't retry network tools." },
  { cls: "shell", verb: "run shell commands", recovery: "Use direct file tools (read/write/edit) if those are allowed, or tell the user the exact command to run themselves." },
  { cls: "sensitive-read", verb: "read local files or data", recovery: "Answer from what is already in the conversation context; don't retry read tools." },
];

/** Map pack id → ToolBlocked stage so the existing caller-side stage map
 *  (in tool-executor.ts) keeps working unchanged. */
const PACK_TO_STAGE: Record<string, ToolBlockedStage> = {
  "spend-cap": "tool-policy",
  "security-layer": "security",
  "default-policy": "tool-policy",
  "threat-engine": "threat",
  "arikernel": "arikernel",
  "egress-refutation": "threat",
};

export async function assertToolCallAllowed(
  call: ToolCallShape,
  ctx: PreDispatchCtx,
): Promise<void> {
  // Per-session gate (not a rule pack — session-scoped runtime toggle).
  if (!ctx.skipSessionPolicy) {
    const sessionBlock = checkSessionPolicy(ctx.sessionId, call.name);
    if (sessionBlock) throw new ToolBlocked({ stage: "session-policy", reason: sessionBlock });
  }

  // Category-level kill-switches from Settings → Security → Tool Policy.
  // These sit ABOVE the rule packs so a flipped-off category short-circuits
  // before any rule eval. Cheap, predictable, user-visible.
  const cfg = getRuntimeConfig();
  const { localOnlyToolDecision } = await import("../local-only-policy.js");
  const localOnly = localOnlyToolDecision(call.name, call.args as Record<string, unknown>, cfg);
  if (!localOnly.allowed) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: localOnly.reason!,
      recovery: "Disable strict local-only mode in Settings → Security only when the user explicitly wants remote access.",
      userHint: USER_HINTS.policy,
    });
  }
  // The shell kill-switch covers every shell-class tool, not just `bash`: the
  // process_* family spawns the same /bin/bash -c (or powershell) subprocess,
  // so leaving them on while Shell is off would be a silent bypass of the
  // user's own toggle.
  if ((call.name === "bash" || call.name.startsWith("process_")) && cfg.enableShell === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "Shell Access is disabled in Settings → Security → Tool Policy.",
      recovery: "Shell is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableShell=true. Don't re-enable it on your own just to get past this block. Other tools (write/edit/http_request) still work.",
      userHint: USER_HINTS.policy,
    });
  }
  if (call.name === "http_request" && cfg.enableHttp === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "HTTP Requests are disabled in Settings → Security → Tool Policy.",
      recovery: "HTTP is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableHttp=true. Don't re-enable it on your own just to get past this block.",
      userHint: USER_HINTS.policy,
    });
  }
  if (call.name.startsWith("browser") && cfg.enableBrowser === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "Browser is disabled in Settings → Security → Tool Policy.",
      recovery: "The browser is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableBrowser=true. Don't re-enable it on your own just to get past this block.",
      userHint: USER_HINTS.policy,
    });
  }
  // Computer control defaults OFF (high-risk opt-in). On macOS it ALSO needs
  // the Accessibility permission — but that's enforced in the driver; here we
  // gate on the user-facing kill-switch.
  if (call.name === "computer" && cfg.enableComputerControl === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "Computer control (mouse/keyboard) is disabled in Settings → Security → Tool Policy.",
      recovery: "Computer control is off (off by default). Tell the user it must be enabled in Settings → Security, and that macOS also needs Accessibility permission. Don't re-enable it on your own just to get past this block.",
      userHint: USER_HINTS.policy,
    });
  }

  // Per-op user prohibitions — the instruction ledger records capability
  // classes the USER forbade for this op ("don't edit anything", "no
  // network") — plus the session's ENFORCED PLAN MODE, a standing mandate the
  // user flips via the Plan toggle that forbids the mutation classes until
  // they approve. Sits beside the kill-switches: same shape (cheap,
  // predictable, user-stated), narrower scope. Keyed on CAPABILITY CLASS via
  // hasCapability — never literal tool names — so synonyms (ari_file,
  // process_start, browser_navigate) are gated identically to canonicals.
  // FAIL-OPEN: no opId + plan mode off, or an absent/empty ledger, fires
  // nothing; unconstrained ops are untouched.
  const opForbids = (cls: CapabilityClass): boolean =>
    ctx.opId !== undefined && opForbidsCapability(ctx.opId, cls);
  const capForbidden = (cls: CapabilityClass): boolean =>
    opForbids(cls) || planModeForbidsCapability(ctx.sessionId, cls);
  {
    for (const { cls, verb, recovery } of OP_PROHIBITION_GUIDANCE) {
      if (!capForbidden(cls)) continue;
      if (!hasCapability(call.name, cls)) continue;
      // Plan mode gets its own wording — only the user's toggle lifts it, so
      // "ask the user to lift the restriction" would be misleading half-advice.
      if (!opForbids(cls)) {
        throw new ToolBlocked({
          stage: "tool-policy",
          disposition: "hard-deny",
          reason: `Enforced plan mode is on for this session; this ${call.name} call would ${verb} and is blocked. Finish your research, then call exit_plan_mode with a \`summary\` of your plan — the user is shown an approval card, and only their approval (or the Plan toggle) ends plan mode.`,
          recovery,
          userHint: USER_HINTS.planModeEnforced,
        });
      }
      throw new ToolBlocked({
        stage: "tool-policy",
        disposition: "hard-deny",
        reason: `The user asked you not to ${verb} in this request; this ${call.name} call is blocked. Respond without it, or ask the user to lift the restriction.`,
        recovery,
        userHint: USER_HINTS.policy,
      });
    }

    // Shell escape hatch for a workspace-write ban: bash/process_start are
    // SHELL-class, so the capability loop above never catches a shell command
    // that WRITES files (`sed -i`, `cat > f`, a heredoc, `cp`, `rm`…). When
    // workspace writes are forbidden (user-stated OR enforced plan mode),
    // block a mutating shell command too — read-only shell (grep/ls/cat)
    // stays allowed. Best-effort: a bespoke interpreter one-liner can still
    // slip past static analysis; the post-hoc mutation gates catch that.
    if (capForbidden("workspace-write") && hasCapability(call.name, "shell")) {
      const cmd = (call.args as { command?: unknown } | undefined)?.command;
      if (typeof cmd === "string" && shellCommandWritesFiles(cmd)) {
        const cause = opForbids("workspace-write")
          ? "The user asked you not to edit or create files in this request"
          : "Enforced plan mode is on for this session";
        throw new ToolBlocked({
          stage: "tool-policy",
          disposition: "hard-deny",
          reason: `${cause}, and this shell command writes to the filesystem — so it is blocked. Read-only shell (grep, ls, cat) is fine; to change a file, either keep the command read-only or tell the user the exact command to run themselves.`,
          recovery: "Run the command read-only, or report the change for the user to apply.",
          userHint: opForbids("workspace-write") ? USER_HINTS.policy : USER_HINTS.planModeEnforced,
        });
      }
    }
  }

  // Per-role gate (not a rule pack — RBAC is a principal property).
  if (ctx.rbac) {
    const d = ctx.rbac.manager.checkTool(ctx.rbac.role, call.name);
    if (!d.allowed) {
      throw new ToolBlocked({
        stage: "rbac",
        reason: d.reason,
        recovery:
          "This role lacks the permission to call this tool. Use a different tool or ask the user to elevate.",
        userHint: d.userHint ?? USER_HINTS.policy,
      });
    }
  }

  // Unified policy evaluation: one pass over the four rule packs.
  const packs: RulePack[] = [
    makeSpendCapPack(),
    makeSecurityLayerPack(ctx.security),
    makeDefaultPolicyPack(ctx.toolPolicy),
    makeThreatEnginePack(ctx.threatEngine),
    makeArikernelPack(),
    makeEgressRefutationPack(),
  ];
  const decision = await evaluatePolicy(
    { id: call.id, name: call.name, args: call.args },
    packs,
    { sessionId: ctx.sessionId, callContext: ctx.callContext },
  );
  if (!decision.allowed) {
    throw new ToolBlocked({
      stage: PACK_TO_STAGE[decision.deniedBy.packId] ?? "tool-policy",
      disposition: decision.disposition,
      reason: decision.reason,
      recovery: decision.recovery,
      userHint: decision.userHint,
    });
  }

  // User-owned security controls (kill-switches, approval mode, browser mode)
  // may be changed when the user asks in an interactive session, but NEVER in
  // an autonomous run (cron/api/delegated sub-agent) where no user is present.
  // That autonomous block is the hard guarantee; the prompt-side rule "only
  // when the user asks" keeps the agent from flipping one on its own initiative
  // — e.g. re-enabling its own kill-switch to get past a block.
  if (
    call.name === "setting" &&
    isProtectedSetting(String((call.args as { field?: unknown }).field ?? "")) &&
    ctx.callContext !== "local"
  ) {
    const field = String((call.args as { field?: unknown }).field ?? "");
    throw new ToolBlocked({
      stage: "approval",
      reason: `"${field}" is a user-controlled security setting and cannot be changed in an automated/background run.`,
      recovery: "Security settings can only be changed when the user asks in an interactive chat. Surface this to the user instead.",
      userHint: USER_HINTS.policy,
    });
  }

  // Per-user gate (not a rule pack — interactive consent driven by the
  // active autonomy profile). The four-valued Decision branches into:
  // run silently, prompt the user, or block outright.
  if (ctx.approval && ctx.callContext === "local") {
    // Same reclassification as tool-execution/require-approval.ts: an
    // irreversible operation is decided by the profile's destructive tier —
    // no confirm floor above the profile table.
    const destructive = destructiveOperationReason(call.name, call.args);
    let decision = destructive
      ? getRiskDecision("destructive", ctx.sessionId)
      : getToolDecision(call.name, ctx.sessionId);

    // Irreversible-action floor (this block is already local-only): force one
    // confirm before a truly-unrecoverable shell op even if the profile allows
    // it silently. See applyIrreversibleFloor.
    decision = applyIrreversibleFloor(decision, call.name, call.args);

    if (decisionDenies(decision)) {
      throw new ToolBlocked({
        stage: "approval",
        reason: `BLOCKED by profile: ${call.name} (risk class denied)`,
        userHint: USER_HINTS.policy,
      });
    }

    if (decisionRequiresPrompt(decision)) {
      const approved = await getApprovalManager().requestApproval({
        toolName: call.name,
        toolCallId: call.id,
        sessionId: ctx.sessionId,
        context: destructive
          ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approval.context || ""}`
          : ctx.approval.context || "",
        args: call.args,
        alwaysAsk: !!destructive,
        emit: ctx.approval.onEvent,
      });
      if (!approved) {
        throw new ToolBlocked({
          stage: "approval",
          reason: `User declined (or did not confirm) ${call.name}. Do NOT re-issue this exact call — an identical retry is auto-declined this turn. Move on or report what you couldn't complete.`,
          recovery: `The user did not approve this action. Re-issuing the same call will not prompt again. Skip it and continue, or tell the user what you need them to approve.`,
          userHint: USER_HINTS.policy,
        });
      }
    }
  }
}
