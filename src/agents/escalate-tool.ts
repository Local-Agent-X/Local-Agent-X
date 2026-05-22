/**
 * agent_escalate — first-class escalation primitive.
 *
 * Lets a running agent push a blocker, decision, or status report UP the
 * org chart. The agent_wakeup tool is for peer-level / downward messaging
 * (you mention someone on a shared issue); this one is the structured
 * "I'm stuck, who needs to know" primitive that the Manager template and
 * future watchdog rely on.
 *
 * Resolution of `to`:
 *   - "manager"   → walks the caller's roster.reportsTo. If the caller is
 *                   already at the top of the chain (no reportsTo), the
 *                   tool auto-promotes the escalation to "user".
 *   - "user"      → emits handler:agent-escalation on the EventBus, which
 *                   the server forwarder turns into a chat-UI notification.
 *   - <agentId>   → wakes that agent via the canonical invoke layer (same
 *                   path agent_wakeup uses). Cross-project rejected.
 *
 * Urgency:
 *   - "high"   → out-of-cycle wake (invokeAgent) in addition to leaving a
 *                comment when an issueId is supplied.
 *   - "normal" → record-only: comment if issueId, no wake.
 *
 * Caller identity:
 *   The tool executor stamps _sessionId on session-scoped tool calls. For
 *   sub-agent calls the session looks like "agent-<runId>"; we look up the
 *   Handler's FieldAgent record for that runId to recover the calling
 *   agent's templateId. Without a templateId, "to: manager" is invalid
 *   (the user has no reportsTo to walk) and the tool returns an error.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import {
  AgentTemplateStore,
  ProjectStore,
} from "../agent-store.js";
import { ProjectRosterStore } from "../project-rosters.js";
import { IssueStore } from "../agent-store.js";
import { Handler } from "../agency/handler.js";
import type { FieldAgentStatus } from "../agency/handler-types.js";
import { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-escalate");

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

interface CallerContext {
  templateId?: string;
  templateName?: string;
  projectId?: string;
}

/** Resolve the calling agent's identity from the injected _sessionId.
 *  Returns an empty context (no templateId) when the caller is the
 *  human user driving the chat — that's a valid path for `to: "user"`
 *  but not for `to: "manager"`. */
function resolveCallerContext(sessionId: string): CallerContext {
  if (!sessionId.startsWith("agent-")) return {};
  const runId = sessionId.slice("agent-".length);
  let status: FieldAgentStatus | undefined;
  try {
    const result = Handler.getInstance().getAgentStatus(runId);
    if (!Array.isArray(result)) status = result;
  } catch {
    // FieldAgent already cleaned up (terminal + 5min) — treat as unknown caller.
    return {};
  }
  if (!status?.templateId) return {};
  const tpl = AgentTemplateStore.getInstance().get(status.templateId);
  const project = ProjectStore.getInstance().getAgentProject(status.templateId);
  return {
    templateId: status.templateId,
    templateName: tpl?.name,
    projectId: project?.id,
  };
}

async function wakeTarget(
  targetTemplateId: string,
  callerName: string,
  context: string,
  projectId: string | undefined,
  issueId: string | undefined,
): Promise<void> {
  const task = `You were escalated to by ${callerName}.\n\n` +
    `Context: ${context}\n\n` +
    (issueId ? `Anchor issue: ${issueId}. Read it before responding.\n\n` : "") +
    `First call agent_whoami with agentId="${targetTemplateId}" to load your state, then act on the escalation.`;
  const { invokeAgent } = await import("./invoke.js");
  invokeAgent(targetTemplateId, task, {
    scope: projectId ? { projectId } : undefined,
  });
}

export const agentEscalate: ToolDefinition = {
  name: "agent_escalate",
  description:
    "Escalate a blocker, decision-needed, or status report up the chain. " +
    "Resolves `to` against the caller's roster: 'manager' walks reportsTo " +
    "(auto-promotes to 'user' when you have no manager); 'user' surfaces " +
    "to the chat UI as a notification; an explicit agentId wakes that " +
    "agent directly. Urgency 'high' wakes the target out-of-cycle in " +
    "addition to leaving a record; 'normal' leaves a record they'll see " +
    "on their next wake.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "'manager' | 'user' | <agentId>" },
      context: { type: "string", description: "What this is about — situation summary, what you need from them." },
      urgency: { type: "string", enum: ["normal", "high"], description: "'high' wakes target now; 'normal' leaves a record." },
      issueId: { type: "string", description: "Optional — anchor the escalation to an issue for audit trail." },
    },
    required: ["to", "context", "urgency"],
  },
  async execute(args): Promise<ToolResult> {
    const to = String(args.to || "").trim();
    const context = String(args.context || "").trim();
    const urgency = String(args.urgency || "").trim();
    const issueId = args.issueId ? String(args.issueId) : undefined;
    const sessionId = String(args._sessionId || "");

    if (!to) return err("agent_escalate requires `to` ('manager' | 'user' | <agentId>).");
    if (!context) return err("agent_escalate requires `context` describing the situation.");
    if (urgency !== "normal" && urgency !== "high") {
      return err(`agent_escalate requires urgency 'normal' or 'high', got "${urgency}".`);
    }

    const caller = resolveCallerContext(sessionId);
    const callerName = caller.templateName ?? "user";

    // Optional issue anchor — validate up front so we comment on the right
    // record even when the destination resolves to "user" via fallback.
    const issueStore = IssueStore.getInstance();
    const issue = issueId ? issueStore.get(issueId) : undefined;
    if (issueId && !issue) return err(`Issue ${issueId} not found.`);

    // ── Resolve `to` ────────────────────────────────────────────────
    let resolvedTarget: "user" | { kind: "agent"; templateId: string; templateName: string; projectId?: string };
    if (to === "user") {
      resolvedTarget = "user";
    } else if (to === "manager") {
      if (!caller.templateId) {
        return err("agent_escalate to:'manager' requires a sub-agent caller; chat sessions have no roster to walk.");
      }
      // Project-scoped reportsTo lives on the roster, not the template. If
      // the caller is on multiple projects, prefer the one matching the
      // anchor issue; otherwise take the first and log a warning.
      const rosters = ProjectRosterStore.getInstance().listByAgent(caller.templateId);
      let roster = rosters.find((r) => r.projectId === issue?.projectId);
      if (!roster && rosters.length > 0) {
        roster = rosters[0];
        if (rosters.length > 1) {
          logger.warn(`[escalate] caller ${caller.templateId} is on ${rosters.length} projects; picked ${roster.projectId} for manager walk`);
        }
      }
      const managerId = roster?.reportsTo;
      if (!managerId) {
        // Top of the chain — auto-promote to user.
        resolvedTarget = "user";
      } else {
        const managerTpl = AgentTemplateStore.getInstance().get(managerId);
        if (!managerTpl) return err(`agent_escalate: reportsTo target ${managerId} not found in template store.`);
        resolvedTarget = {
          kind: "agent",
          templateId: managerTpl.id,
          templateName: managerTpl.name,
          projectId: roster?.projectId,
        };
      }
    } else {
      // Explicit agentId.
      const targetTpl = AgentTemplateStore.getInstance().get(to);
      if (!targetTpl) return err(`agent_escalate: agent ${to} not found.`);
      if (ProjectRosterStore.getInstance().listByAgent(to).length === 0) {
        return err(`agent_escalate: agent ${to} is not rostered in any project.`);
      }
      // Cross-project gate — mirror agent_wakeup. Acting agent must share
      // a project with the target.
      if (caller.projectId) {
        const targetProject = ProjectStore.getInstance().getAgentProject(to);
        if (targetProject && targetProject.id !== caller.projectId) {
          return err(`agent_escalate: ${targetTpl.name} is in project "${targetProject.name}", a different project from the caller. Escalate to your manager or to the user instead.`);
        }
      }
      resolvedTarget = {
        kind: "agent",
        templateId: targetTpl.id,
        templateName: targetTpl.name,
        projectId: caller.projectId,
      };
    }

    // ── Side-effects ────────────────────────────────────────────────
    const summary = context.length > 120 ? `${context.slice(0, 117)}...` : context;

    if (issue) {
      const targetLabel = resolvedTarget === "user" ? "user" : resolvedTarget.templateName;
      issueStore.comment(
        issue.id,
        "system",
        `Escalated to ${targetLabel} (${urgency}) by ${callerName}: ${summary}`,
      );
    }

    if (resolvedTarget === "user") {
      await EventBus.emit("handler:agent-escalation", {
        from: caller.templateId || "user",
        fromName: callerName,
        to: "user",
        context,
        urgency,
        issueId,
      });
      return ok(`Escalated to user (${urgency}): ${summary}`);
    }

    // Agent target. urgency: "high" wakes via canonical invoke; "normal"
    // leaves the comment + emits a low-priority handler event so the
    // target picks it up on next heartbeat.
    if (urgency === "high") {
      try {
        await wakeTarget(resolvedTarget.templateId, callerName, context, resolvedTarget.projectId, issueId);
      } catch (e) {
        return err(`agent_escalate: failed to wake ${resolvedTarget.templateName}: ${(e as Error).message}`);
      }
      return ok(`Escalated to ${resolvedTarget.templateName} (high — woken now): ${summary}`);
    }

    await EventBus.emit("handler:agent-escalation", {
      from: caller.templateId || "user",
      fromName: callerName,
      to: resolvedTarget.templateId,
      toName: resolvedTarget.templateName,
      context,
      urgency,
      issueId,
    });
    return ok(`Escalated to ${resolvedTarget.templateName} (normal — record only): ${summary}`);
  },
};
