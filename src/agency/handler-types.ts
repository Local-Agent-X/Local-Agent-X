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
}

export type AgentUpdateCallback = (agentId: string, update: {
  type: "output" | "status" | "complete" | "error";
  data: string;
}) => void;
