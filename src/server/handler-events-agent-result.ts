import { formatAgentDisplayName } from "../agency/agent-display-name.js";
import { looksLikeClarificationRequest } from "../agents/result-guard.js";
import type { AgentRun, AgentRunStore } from "../agent-store/index.js";
import type { SessionStore } from "../memory/index.js";
import type { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";
const logger = createLogger("server.handler-events");

// Spawn/result lifecycle listeners, split out of handler-events.ts (400-LOC
// gate). handler-events.ts still owns the driver + the shared pendingMeta
// map (its tool_start hook appends toolsUsed); this module owns what
// happens when a run starts and when it finishes.

export interface AgentSpawnEvent { agentId: string; name: string; role: string; task: string; systemPrompt?: string; parentAgentId?: string | null; parentSessionId?: string; templateId?: string | null }
export interface AgentResultEvent { agentId: string; result: string; success: boolean; tokens?: number; name?: string }

export interface PendingAgentMeta {
  name: string;
  role: string;
  task: string;
  systemPrompt: string;
  parentAgentId: string | null;
  sessionId: string;
  startedAt: number;
  toolsUsed: string[];
  templateId: string | null;
}

/**
 * Orchestrator-child discriminator.
 *
 * `parentAgentId` is the ONLY reliable signal today that a spawned agent
 * belongs to a harness orchestrator rather than to the user's chat:
 *   - auto-build threads the orchestrator run's op id as `parentOpId` →
 *     `parentAgentId` for every chunk / retry / preflight worker
 *     (src/auto-build/orchestrator/manager.ts → loop/run.ts →
 *     loop/preflight.ts, loop/run-chunk-once.ts, loop/parallel-waves.ts,
 *     loop/handle-push-back.ts → agents/chunk-runner.ts) and consumes each
 *     worker's report itself (run-chunk-once.ts review + judgment,
 *     handle-push-back.ts). The scenario-fix worker
 *     (src/auto-build/scenario-scorer/auto-fix.ts, called from
 *     src/auto-build/loop-phase-gate.ts) threads NEITHER key — no
 *     parentSessionId means nothing is injected for it either way;
 *   - a chat-initiated `agent_spawn` (src/agents/tools.ts) never sets it,
 *     so invoke.ts emits `parentAgentId: null`.
 * Both kinds thread the user's REAL chat session as parentSessionId, so
 * sessionId alone cannot tell them apart. An orchestrator child's report
 * must not be injected into that chat — otherwise every "Agent Chunk
 * runner completed: STATUS: done …" lands in the user's transcript AND
 * the model's history (2026-08-30 overnight build). A chat-spawned
 * agent's report still belongs there: the user asked for that agent.
 */
export function isOrchestratorChild(meta: Pick<PendingAgentMeta, "parentAgentId">): boolean {
  return typeof meta.parentAgentId === "string" && meta.parentAgentId.length > 0;
}

export function registerAgentLifecycleEvents(deps: {
  eventBus: ReturnType<typeof EventBus.getInstance>;
  pendingMeta: Map<string, PendingAgentMeta>;
  sessionStore: Pick<SessionStore, "load" | "save">;
  agentRunStore: Pick<AgentRunStore, "save">;
  broadcastAll: (event: Record<string, unknown>) => void;
}): void {
  const { eventBus, pendingMeta, sessionStore, agentRunStore, broadcastAll } = deps;

  eventBus.on("handler:agent-spawn", (d: unknown) => {
    const evt = d as AgentSpawnEvent;
    const displayName = formatAgentDisplayName({ name: evt.name, role: evt.role, task: evt.task });
    const parentAgentId = evt.parentAgentId || null;
    const parentSessionId = evt.parentSessionId || "";
    // parentSessionId + parentAgentId are stated explicitly (not left to the
    // spread) so the client can rely on both keys being present.
    broadcastAll({ type: "agent-spawn", ...evt, name: displayName, displayName, rawName: evt.name, parentSessionId, parentAgentId });
    pendingMeta.set(evt.agentId, { name: displayName, role: evt.role, task: evt.task, systemPrompt: evt.systemPrompt || "", parentAgentId, sessionId: parentSessionId, startedAt: Date.now(), toolsUsed: [], templateId: evt.templateId || null });
  });

  eventBus.on("handler:agent-result", (d: unknown) => {
    const evt = d as AgentResultEvent;
    const m = pendingMeta.get(evt.agentId);
    const displayName = formatAgentDisplayName({ name: evt.name || m?.name, role: m?.role, task: m?.task });
    // sessionId + parentAgentId ride the broadcast so the client can route
    // the result to the chat that spawned it — and skip orchestrator
    // children — instead of appending to whatever chat is open.
    broadcastAll({ type: "agent-complete", ...evt, name: displayName, displayName, sessionId: m?.sessionId ?? "", parentAgentId: m?.parentAgentId ?? null });
    if (m) {
      // Result-shape guard: catch agents that finished by asking the
      // user to resend the task instead of doing it. Without this, a
      // 300-char clarification request quietly persists as status:
      // "done" and inflates the success rate in History. See
      // src/agents/result-guard.ts for the heuristic and rationale.
      const explicitFailure = evt.success === false;
      let guardError: string | undefined;
      if (!explicitFailure && typeof evt.result === "string") {
        const verdict = looksLikeClarificationRequest(evt.result);
        if (verdict.isClarificationRequest) {
          guardError = `Agent bailed without completing the task (clarification-request shape: "${verdict.matchedPhrase}"). Spawned agents do NOT have a conversation channel — they must complete or report a structured blocker.`;
          logger.warn(`[handler] Agent ${evt.agentId} (${m.role}) bailed with clarification request — re-classified as error`);
        }
      }
      const status: AgentRun["status"] = explicitFailure || guardError ? "failed" : "succeeded";
      const errorField = explicitFailure ? evt.result : guardError;
      agentRunStore.save({ id: evt.agentId, parentAgentId: m.parentAgentId, sessionId: m.sessionId, name: m.name, role: m.role, task: m.task, systemPrompt: m.systemPrompt, status, output: [], result: evt.result || "", toolsUsed: m.toolsUsed, tokensUsed: evt.tokens || 0, startedAt: m.startedAt, completedAt: Date.now(), error: errorField, templateId: m.templateId || undefined } as AgentRun);
      // Chat-initiated spawns only — an orchestrator child's report is
      // consumed by the orchestrator, never by the user's chat.
      if (m.sessionId && evt.result && !isOrchestratorChild(m)) {
        try {
          const parentSession = sessionStore.load(m.sessionId);
          if (parentSession) {
            const label = evt.success === false ? `Agent ${m.name} failed` : `Agent ${m.name} completed`;
            parentSession.messages.push({ role: "assistant", content: `**${label}:**\n\n${evt.result}` } as any);
            parentSession.updatedAt = Date.now();
            sessionStore.save(parentSession);
          }
        } catch {}
      }
      pendingMeta.delete(evt.agentId);
    }
  });
}
