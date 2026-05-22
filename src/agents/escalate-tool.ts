/**
 * agent_escalate — first-class escalation primitive.
 *
 * Lets a running agent push a blocker, decision, or status report UP the
 * org chart. The agent_wakeup tool is for peer-level / downward messaging
 * (you mention someone on a shared issue); this one is the structured
 * "I'm stuck, who needs to know" primitive that the Manager template and
 * the stall watchdog both rely on.
 *
 * Behavior lives in escalation-core.ts so the watchdog can reuse it
 * without faking a _sessionId. This tool does three things only:
 *   1. validate the user-facing args,
 *   2. resolve the caller's templateId from the injected _sessionId,
 *   3. call performEscalation and forward the outcome.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import { Handler } from "../agency/handler.js";
import { performEscalation } from "./escalation-core.js";

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Pull the calling agent's templateId from the session id the tool
 *  executor stamps on session-scoped tool calls. Returns undefined when
 *  the caller is the human user driving chat — that's still valid for
 *  `to: "user"` / explicit <agentId>, but performEscalation rejects
 *  `to: "manager"` because there's no roster to walk. */
function resolveCallerAgentId(sessionId: string): string | undefined {
  if (!sessionId.startsWith("agent-")) return undefined;
  const runId = sessionId.slice("agent-".length);
  try {
    const result = Handler.getInstance().getAgentStatus(runId);
    if (Array.isArray(result)) return undefined;
    return result?.templateId;
  } catch {
    // FieldAgent already cleaned up (terminal + 5min) — treat as
    // unknown caller; performEscalation will reject to:'manager'.
    return undefined;
  }
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

    const outcome = await performEscalation({
      callerAgentId: resolveCallerAgentId(sessionId),
      to,
      context,
      urgency,
      issueId,
    });
    return outcome.ok ? ok(outcome.message) : err(outcome.message);
  },
};
