import type { AgencyAgent, AgentStatus } from "./types.js";

export interface FieldAgent extends AgencyAgent {
  output: string[];
  streamCallback?: (agentId: string, chunk: string) => void;
  abortController?: AbortController;
  pauseSignal?: { paused: boolean; resume?: () => void };
  startedAt: number;
  tokensUsed: number;
  messageQueue: string[];
  templateId?: string;
  /** Captured at spawn time to avoid the singleton race on Handler.currentSessionId */
  parentSessionId?: string;
  /** Borrowed/synthetic runtime session id this run's tools record taint under
   *  (the `opts.sessionId` passed to invokeDefinition — e.g. `agent-op-<id>` for
   *  operations-executor phases). Undefined when the run uses its auto-minted
   *  `agent-<id>` session. pushCompletionToParent propagates taint FROM this
   *  bucket so it always matches where the child's tools actually recorded —
   *  see handler-events.ts `runSessionId = req.sessionId ?? agent-<agentId>`. */
  runSessionId?: string;
  /** Real progress signal: count of tool calls this run has started. The old
   *  progress heuristic keyed off output.length, which stays empty for external
   *  (canonical-loop) runs since their text streams elsewhere — so progress was
   *  pinned at 0 the entire run. noteAgentActivity increments this on each
   *  tool_start; buildStatus derives a live percentage from it. */
  toolCalls?: number;
}

export interface FieldAgentStatus {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTask: string | undefined;
  progress: number;
  outputLines: number;
  startedAt: number;
  elapsed: number;
  tokensUsed: number;
  /** Definition this run is bound to. Exposed so tools that need to map
   *  a runId back to the calling agent's template (e.g. agent_escalate
   *  resolving the caller's roster) can do it through the public API. */
  templateId?: string;
}

export interface SpawnConfig {
  name: string;
  role: string;
  task: string;
  systemPrompt?: string;
  tools?: string[];
  parentSessionId?: string;
  parentAgentId?: string;
  templateId?: string;
  /** Borrowed runtime session id (invokeDefinition's `opts.sessionId`). When set,
   *  the run's tools record taint under this id instead of `agent-<id>`; stored on
   *  the FieldAgent so completion-time taint propagation reads the right bucket. */
  runSessionId?: string;
}

export type AgentUpdateCallback = (agentId: string, update: {
  type: "output" | "status" | "complete" | "error";
  data: string;
}) => void;
