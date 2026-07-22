/**
 * Pre-dispatch gate chain — the checks every tool call must pass before
 * execution, regardless of which dispatcher routed it. Both the chat-path
 * (canonical-loop/chat-tool-dispatcher.ts) and the AriKernel-path
 * (packages/arikernel/tool-executors/*) call this, closing F3 from DRY-AUDIT.md.
 *
 * Policy evaluation is unified through src/tool-policy/evaluator.ts (F4).
 * Five packs (spend-cap, security-layer, default-policy, threat-engine,
 * egress-refutation) are evaluated in one pass; session-policy /
 * RBAC / approval remain per-user gates outside the pack mechanism.
 */
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import {
  decisionRequiresPrompt,
  decisionDenies,
  applyIrreversibleFloor,
  destructiveOperationReason,
} from "../approval-manager.js";
import type { CapabilityClass } from "../tool-registry.js";
import { shellCommandWritesFiles } from "../security/layer/index.js";
import { isProtectedSetting } from "../settings-schema.js";
import { supervisedEvaluateBlock } from "./supervised-browser-gate.js";
import { computerRedirectBlock, killSwitchBlock, screenCaptureRedirectBlock } from "./kill-switch-gates.js";
import type { ServerEvent } from "../types.js";
import { USER_HINTS } from "../types.js";
import { evaluate as evaluatePolicy, type RulePack } from "../tool-policy/evaluator.js";
import { makeSecurityLayerPack } from "../tool-policy/packs/security-layer-pack.js";
import { makeDefaultPolicyPack } from "../tool-policy/packs/default-policy-pack.js";
import { makeThreatEnginePack } from "../tool-policy/packs/threat-engine-pack.js";
import { resolvePreDispatchDeps, type PreDispatchDeps } from "./pre-dispatch-deps.js";
import { formatConstraintSource } from "../canonical-loop/public/plan-ledger.js";

export type { PreDispatchDeps, PreDispatchApprovalManager, PreDispatchRuntimeFlags } from "./pre-dispatch-deps.js";

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
  /** Overrides for the module singletons the gate chain reads (runtime config
   *  kill-switches, local-only policy, instruction ledger / plan mode,
   *  autonomy profile, approval manager, singleton-backed packs). Absent
   *  fields fall back to the live singletons — production callers pass
   *  nothing; tests inject fakes here instead of vi.mock. */
  deps?: PreDispatchDeps;
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
 *  (in tool-execution/execute-tool.ts) keeps working unchanged. */
const PACK_TO_STAGE: Record<string, ToolBlockedStage> = {
  "spend-cap": "tool-policy",
  "security-layer": "security",
  "default-policy": "tool-policy",
  "threat-engine": "threat",
  "egress-refutation": "threat",
};

export async function assertToolCallAllowed(
  call: ToolCallShape,
  ctx: PreDispatchCtx,
): Promise<void> {
  const d = resolvePreDispatchDeps(ctx.deps);

  // Per-session gate (not a rule pack — session-scoped runtime toggle).
  if (!ctx.skipSessionPolicy) {
    const sessionBlock = d.checkSessionPolicy(ctx.sessionId, call.name);
    if (sessionBlock) throw new ToolBlocked({ stage: "session-policy", reason: sessionBlock });
  }

  // Category-level kill-switches from Settings → Security → Tool Policy.
  // These sit ABOVE the rule packs so a flipped-off category short-circuits
  // before any rule eval. Cheap, predictable, user-visible.
  const cfg = d.getRuntimeConfig();
  const localOnly = await d.localOnlyToolDecision(call.name, call.args as Record<string, unknown>, cfg);
  if (!localOnly.allowed) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: localOnly.reason!,
      recovery: "Disable strict local-only mode in Settings → Security only when the user explicitly wants remote access.",
      userHint: USER_HINTS.policy,
    });
  }
  // Category kill-switches (shell / http / browser / computer control) come
  // from the declarative table in kill-switch-gates.ts — one shared recovery
  // template guarantees every block names the exact `setting` field, so an
  // agent is never left guessing at the wrong layer (tool-policy rules, HTTP
  // endpoints). See that module's header for the incident that motivated it.
  const killSwitch = killSwitchBlock(call.name, cfg);
  if (killSwitch) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: killSwitch.reason,
      recovery: killSwitch.recovery,
      userHint: USER_HINTS.killSwitch,
    });
  }
  // Screen-capture redirect: a session that owns a live in-app browser view
  // and calls screen_capture WITHOUT the explicit target:"os-screen" override
  // is almost always trying to see its own browser pane — deny with the right
  // move spelled out (browser {action:"screenshot"}) instead of letting it
  // guess coordinates off a whole-monitor image. Live session state, not
  // config, so it sits beside (not in) the kill-switch table; the getter is
  // lazy so the browser subsystem is only consulted for screen_capture calls.
  // Its actuation sibling: `computer` coordinate actions (click/move/drag)
  // while a live in-app view exists are the same escape hatch one step later
  // — a failed browser interaction falling back to blind monitor-pixel
  // clicks on the agent's own pane. Both gates share the redirect shape; the
  // computer override token (target:"os-desktop") is deliberately distinct.
  const redirect =
    (await screenCaptureRedirectBlock(call, () => d.hasInAppBrowserView(ctx.sessionId))) ??
    (await computerRedirectBlock(call, () => d.hasInAppBrowserView(ctx.sessionId)));
  if (redirect) {
    // No USER_HINTS entry fits (the `policy` hint points at tool-policy.json —
    // the wrong layer here); the reason is already user-comprehensible.
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: redirect.reason,
      recovery: redirect.recovery,
    });
  }
  // Supervised browser mode. DEFAULT OFF — the in-app browser is autonomous,
  // so browser.evaluate runs without a prompt (a sibling chunk sets the
  // tool-policy default to allow). When the user opts INTO supervision, the gate
  // restores confirm-on-evaluate EXCEPT on the general trusted-origin allowlist.
  // The site-agnostic decision lives in supervised-browser-gate.ts (which
  // consults src/browser/trusted-origins.ts); fail SAFE toward approval.
  const supervised = await supervisedEvaluateBlock(cfg.supervisedBrowser, call, () =>
    d.getBrowserCurrentUrl(ctx.sessionId),
  );
  if (supervised) {
    throw new ToolBlocked({
      stage: "approval",
      disposition: "approval-required",
      reason: supervised.reason,
      recovery: supervised.recovery,
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
    ctx.opId !== undefined && d.opForbidsCapability(ctx.opId, cls);
  const capForbidden = (cls: CapabilityClass): boolean =>
    opForbids(cls) || d.planModeForbidsCapability(ctx.sessionId, cls);
  {
    for (const { cls, verb, recovery } of OP_PROHIBITION_GUIDANCE) {
      if (!capForbidden(cls)) continue;
      if (!d.hasCapability(call.name, cls)) continue;
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
        // The quoted source phrase makes a ledger misextraction diagnosable.
        reason: `The user asked you not to ${verb} in this request${formatConstraintSource(d.opConstraintPhrases(ctx.opId ?? ""))}; this ${call.name} call is blocked. Respond without it, or ask the user to lift the restriction.`,
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
    if (capForbidden("workspace-write") && d.hasCapability(call.name, "shell")) {
      const cmd = (call.args as { command?: unknown } | undefined)?.command;
      if (typeof cmd === "string" && shellCommandWritesFiles(cmd)) {
        const cause = opForbids("workspace-write")
          ? `The user asked you not to edit or create files in this request${formatConstraintSource(d.opConstraintPhrases(ctx.opId ?? ""))}`
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

  // Unified policy evaluation: one pass over the rule packs.
  const packs: RulePack[] = [
    d.makeSpendCapPack(),
    makeSecurityLayerPack(ctx.security),
    makeDefaultPolicyPack(ctx.toolPolicy),
    makeThreatEnginePack(ctx.threatEngine),
    d.makeEgressRefutationPack(),
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

  // Lowering the strict local-only boundary is never delegated to the active
  // autonomy profile. Even an "allow" profile or remembered setting grant
  // must produce a fresh, explicit user confirmation every time.
  if (
    call.name === "setting" &&
    String((call.args as { field?: unknown }).field ?? "") === "localOnlyMode" &&
    (call.args as { value?: unknown }).value === false
  ) {
    if (ctx.callContext !== "local" || !ctx.approval) {
      throw new ToolBlocked({
        stage: "approval",
        reason: "Disabling strict local-only mode requires explicit user approval in an interactive session.",
        userHint: USER_HINTS.policy,
      });
    }
    const approved = await d.getApprovalManager().requestApproval({
      toolName: call.name,
      toolCallId: call.id,
      sessionId: ctx.sessionId,
      context: "Disable strict local-only mode and restore remote network access?",
      args: call.args,
      alwaysAsk: true,
      opId: ctx.opId,
      emit: ctx.approval.onEvent,
    });
    if (!approved) {
      throw new ToolBlocked({
        stage: "approval",
        reason: "The user did not approve disabling strict local-only mode.",
        userHint: USER_HINTS.policy,
      });
    }
    return;
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
      ? d.getRiskDecision("destructive", ctx.sessionId)
      : d.getToolDecision(call.name, ctx.sessionId);

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
      const approved = await d.getApprovalManager().requestApproval({
        toolName: call.name,
        toolCallId: call.id,
        sessionId: ctx.sessionId,
        context: destructive
          ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approval.context || ""}`
          : ctx.approval.context || "",
        args: call.args,
        alwaysAsk: !!destructive,
        opId: ctx.opId,
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
