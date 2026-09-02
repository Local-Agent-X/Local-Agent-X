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
// `success` is honestly tri-state on the wire: emitters normally set a
// boolean, but an event that omits it must read as "completed (unknown
// status)" — never as a failure. agentCompleteChatRow + the AgentRun status
// mapping below and the client (public/js/chat-ws-handler-misc.js) all pivot
// on `success === false` only.
export interface AgentResultEvent { agentId: string; result: string; success?: boolean; tokens?: number; name?: string }

/**
 * The ONE chat-row format for a finished agent — the exact bytes persisted
 * into the parent session AND rendered live by the client
 * (public/js/chat-ws-handler-misc.js buildAgentCompleteRow). The two sides
 * cannot share a constant across the src/public boundary (the client is a
 * classic browser global-script, not a module), so
 * test/chat-ws-agent-complete-routing.test.ts evaluates BOTH builders over
 * the full success × result matrix and asserts byte-identical output —
 * drift in either file breaks CI.
 *
 * Rules the client mirrors:
 *   - tri-state success: only `success === false` reads "failed"; true AND
 *     undefined read "completed" (the run store records "succeeded" for
 *     undefined — an unknown outcome is not a failure).
 *   - empty result → null: nothing is persisted, so the client must render
 *     and store nothing either (a client-only synthesized row would vanish
 *     on the next server-wins hydrate).
 *   - no ✅/❌ prefix: hydrate classifies rows by byte equality; a decorated
 *     live render would be silently swapped for this persisted copy on
 *     reload.
 */
export function agentCompleteChatRow(name: string, success: boolean | undefined, result: string): string | null {
  if (!result) return null;
  return `**Agent ${name} ${success === false ? "failed" : "completed"}:**\n\n${result}`;
}

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
 * belongs to another run rather than to the user's chat:
 *   - auto-build threads the orchestrator run's op id as `parentOpId` →
 *     `parentAgentId` for every chunk / retry / preflight worker
 *     (src/auto-build/orchestrator/manager.ts → loop/run.ts →
 *     loop/preflight.ts, loop/run-chunk-once.ts, loop/parallel-waves.ts,
 *     loop/handle-push-back.ts → agents/chunk-runner.ts) and consumes each
 *     worker's report itself (run-chunk-once.ts review + judgment,
 *     handle-push-back.ts). The scenario-fix worker
 *     (src/auto-build/scenario-scorer/auto-fix.ts, called from
 *     src/auto-build/loop-phase-gate.ts) threads BOTH keys the same way;
 *   - agent-to-agent system wakes (agent_wakeup, agent_escalate
 *     urgency:'high', issue_update's blocked→manager wake) carry the
 *     calling RUN's id as parentAgentId (callerRunIdFromSession in
 *     src/agents/invoke.ts) and NO parentSessionId — lineage nests, and
 *     there is no chat to inject into either way;
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
      // consumed by the orchestrator, never by the user's chat. The persisted
      // row uses `displayName` — the SAME name the agent-complete broadcast
      // carries — not spawn-time m.name: if the result event renames the
      // agent, the client renders the new name, and persisting the old one
      // would silently swap the row's bytes on the next hydrate.
      const row = agentCompleteChatRow(displayName, evt.success, evt.result || "");
      if (m.sessionId && row !== null && !isOrchestratorChild(m)) {
        try {
          const parentSession = sessionStore.load(m.sessionId);
          if (parentSession) {
            parentSession.messages.push({ role: "assistant", content: row } as any);
            parentSession.updatedAt = Date.now();
            sessionStore.save(parentSession);
          }
        } catch {}
      }
      pendingMeta.delete(evt.agentId);
    }
  });
}
