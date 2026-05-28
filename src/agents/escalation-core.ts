/**
 * Shared escalation helper. The agent_escalate tool (chunk 2) and the
 * stall watchdog (chunk 3) both need to "given a caller agent + target +
 * urgency, resolve the target → leave an audit comment → wake or
 * record." The tool route extracts the caller from a sub-agent session
 * id; the watchdog already knows the caller because it triggered the
 * escalation itself. So this helper takes `callerAgentId` as a plain
 * argument — no _sessionId games — and the tool's execute() shrinks to
 * "parse args, look up caller, delegate."
 *
 * Behavior matches chunk 2's tool one-for-one — same target resolution,
 * same audit-comment shape, same wake-vs-record split. Existing tests
 * in escalate-tool.test.ts assert that behavior; they pass unchanged.
 */

import {
  AgentTemplateStore,
  IssueStore,
  ProjectStore,
} from "../agent-store/index.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";

const logger = createLogger("escalation-core");

export interface EscalationRequest {
  /** Template id of the agent doing the escalating. Undefined when the
   *  caller is the human user driving chat — a valid path for
   *  `to: "user"`/<agentId> but not for `to: "manager"` (no roster to
   *  walk). */
  callerAgentId?: string;
  to: string; // "manager" | "user" | <agentId>
  context: string;
  urgency: "normal" | "high";
  issueId?: string;
}

export interface EscalationOutcome {
  ok: boolean;
  /** Human-readable result — success summary or error reason. The tool
   *  surfaces this verbatim back to the calling model. */
  message: string;
  /** "user" or the resolved target's templateId. Useful for tests and
   *  for the watchdog's bookkeeping. Undefined on failure. */
  resolvedTarget?: "user" | string;
  /** True when this escalation triggered an out-of-cycle wake
   *  (urgency:'high' on an agent target). */
  woken: boolean;
}

type ResolvedTarget =
  | "user"
  | { templateId: string; templateName: string; projectId?: string };

export async function performEscalation(
  req: EscalationRequest,
): Promise<EscalationOutcome> {
  const { callerAgentId, to, context, urgency, issueId } = req;

  // Caller identity from the template store — chat-origin escalations
  // (no callerAgentId) record "user" as the source.
  let callerName = "user";
  let callerProjectId: string | undefined;
  if (callerAgentId) {
    const tpl = AgentTemplateStore.getInstance().get(callerAgentId);
    callerName = tpl?.name ?? callerAgentId;
    const project = ProjectStore.getInstance().getAgentProject(callerAgentId);
    callerProjectId = project?.id;
  }

  // Validate anchor issue up front so we comment on the right record
  // even when the destination resolves to "user" via fallback.
  const issueStore = IssueStore.getInstance();
  const issue = issueId ? issueStore.get(issueId) : null;
  if (issueId && !issue) {
    return { ok: false, message: `Issue ${issueId} not found.`, woken: false };
  }

  const target = await resolveTarget(to, { callerAgentId, callerProjectId, anchorProjectId: issue?.projectId });
  if (!target.ok) return { ok: false, message: target.message, woken: false };
  const resolved = target.value;

  // ── Side-effects ──────────────────────────────────────────────────
  const summary = context.length > 120 ? `${context.slice(0, 117)}...` : context;

  if (issue) {
    const targetLabel = resolved === "user" ? "user" : resolved.templateName;
    issueStore.comment(
      issue.id,
      "system",
      `Escalated to ${targetLabel} (${urgency}) by ${callerName}: ${summary}`,
    );
  }

  if (resolved === "user") {
    await EventBus.emit("handler:agent-escalation", {
      from: callerAgentId || "user",
      fromName: callerName,
      to: "user",
      context,
      urgency,
      issueId,
    });
    return {
      ok: true,
      message: `Escalated to user (${urgency}): ${summary}`,
      resolvedTarget: "user",
      woken: false,
    };
  }

  // Agent target. urgency:'high' wakes via canonical invoke; 'normal'
  // emits a low-priority event so the target picks it up on next
  // heartbeat.
  if (urgency === "high") {
    try {
      await wakeTarget(resolved.templateId, callerName, context, resolved.projectId, issueId);
    } catch (e) {
      return {
        ok: false,
        message: `failed to wake ${resolved.templateName}: ${(e as Error).message}`,
        woken: false,
      };
    }
    return {
      ok: true,
      message: `Escalated to ${resolved.templateName} (high — woken now): ${summary}`,
      resolvedTarget: resolved.templateId,
      woken: true,
    };
  }

  await EventBus.emit("handler:agent-escalation", {
    from: callerAgentId || "user",
    fromName: callerName,
    to: resolved.templateId,
    toName: resolved.templateName,
    context,
    urgency,
    issueId,
  });
  return {
    ok: true,
    message: `Escalated to ${resolved.templateName} (normal — record only): ${summary}`,
    resolvedTarget: resolved.templateId,
    woken: false,
  };
}

type TargetResult =
  | { ok: true; value: ResolvedTarget }
  | { ok: false; message: string };

async function resolveTarget(
  to: string,
  ctx: { callerAgentId?: string; callerProjectId?: string; anchorProjectId?: string },
): Promise<TargetResult> {
  if (to === "user") return { ok: true, value: "user" };

  if (to === "manager") {
    if (!ctx.callerAgentId) {
      return {
        ok: false,
        message: "agent_escalate to:'manager' requires a sub-agent caller; chat sessions have no roster to walk.",
      };
    }
    // Project-scoped reportsTo lives on the roster, not the template.
    // If the caller is on multiple projects, prefer the one matching
    // the anchor issue; otherwise take the first and log a warning.
    const rosters = ProjectRosterStore.getInstance().listByAgent(ctx.callerAgentId);
    let roster = rosters.find((r) => r.projectId === ctx.anchorProjectId);
    if (!roster && rosters.length > 0) {
      roster = rosters[0];
      if (rosters.length > 1) {
        logger.warn(`[escalate] caller ${ctx.callerAgentId} is on ${rosters.length} projects; picked ${roster.projectId} for manager walk`);
      }
    }
    const managerId = roster?.reportsTo;
    if (!managerId) return { ok: true, value: "user" };
    const managerTpl = AgentTemplateStore.getInstance().get(managerId);
    if (!managerTpl) {
      return { ok: false, message: `agent_escalate: reportsTo target ${managerId} not found in template store.` };
    }
    return {
      ok: true,
      value: { templateId: managerTpl.id, templateName: managerTpl.name, projectId: roster?.projectId },
    };
  }

  // Explicit agentId.
  const targetTpl = AgentTemplateStore.getInstance().get(to);
  if (!targetTpl) return { ok: false, message: `agent_escalate: agent ${to} not found.` };
  if (ProjectRosterStore.getInstance().listByAgent(to).length === 0) {
    return { ok: false, message: `agent_escalate: agent ${to} is not rostered in any project.` };
  }
  if (ctx.callerProjectId) {
    const targetProject = ProjectStore.getInstance().getAgentProject(to);
    if (targetProject && targetProject.id !== ctx.callerProjectId) {
      return {
        ok: false,
        message: `agent_escalate: ${targetTpl.name} is in project "${targetProject.name}", a different project from the caller. Escalate to your manager or to the user instead.`,
      };
    }
  }
  return {
    ok: true,
    value: { templateId: targetTpl.id, templateName: targetTpl.name, projectId: ctx.callerProjectId },
  };
}

async function wakeTarget(
  targetTemplateId: string,
  callerName: string,
  context: string,
  projectId: string | undefined,
  issueId: string | undefined,
): Promise<void> {
  const task =
    `You were escalated to by ${callerName}.\n\n` +
    `Context: ${context}\n\n` +
    (issueId ? `Anchor issue: ${issueId}. Read it before responding.\n\n` : "") +
    `First call agent_whoami with agentId="${targetTemplateId}" to load your state, then act on the escalation.`;
  const { invokeAgent } = await import("./invoke.js");
  invokeAgent(targetTemplateId, task, {
    scope: projectId ? { projectId } : undefined,
  });
}
