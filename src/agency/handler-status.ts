// Pure FieldAgent → FieldAgentStatus projection — split out of handler.ts
// (source-hygiene LOC ceiling; same layout note as handler-types/handler-tools).
import type { FieldAgent, FieldAgentStatus } from "./handler-types.js";

export function buildAgentStatus(agent: FieldAgent): FieldAgentStatus {
  const done = agent.status === "succeeded" || agent.status === "failed";
  // Real progress: count tool calls the run has started. The old heuristic
  // (output.length * 5) stayed pinned at 0 for canonical-loop runs because
  // their text streams elsewhere and output[] only fills at finalize. Each
  // tool_start bumps toolCalls via noteAgentActivity; cap at 90 so an
  // in-flight run never reads as complete, and a no-tool run that's still
  // working shows a small floor instead of a dead 0.
  const calls = agent.toolCalls ?? 0;
  const working = Math.min(90, calls > 0 ? calls * 8 : 5);
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    currentTask: agent.currentTask,
    progress: done ? 100 : working,
    outputLines: agent.output.length,
    startedAt: agent.startedAt,
    elapsed: Date.now() - agent.startedAt,
    tokensUsed: agent.tokensUsed,
    templateId: agent.templateId,
  };
}
