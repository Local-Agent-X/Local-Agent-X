// Agency System Types

// Vocabulary aligned with the canonical-loop's TerminalState (F13). Handler
// has no separate "cancelled" — cancelAgent sets `failed` with a "[cancelled]"
// output marker (see handler.ts). When F1 retires the Handler this collapses
// into TerminalState directly.
export type AgentStatus = "idle" | "working" | "waiting" | "succeeded" | "failed";
export type MessageType = "task-result" | "request-info" | "share-context" | "status-update";

export interface AgencyAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  systemPrompt: string;
  tools: string[];
  currentTask?: string;
  result?: string;
}

export interface AgencyMessage {
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: number;
}
