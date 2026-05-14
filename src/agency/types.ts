// Agency System Types

// Vocabulary aligned with the canonical-loop's TerminalState (F13). Handler
// has no separate "cancelled" — cancelAgent sets `failed` with a "[cancelled]"
// output marker (see handler.ts). When F1 retires the Handler this collapses
// into TerminalState directly.
export type AgentStatus = "idle" | "working" | "waiting" | "succeeded" | "failed";
export type PlanStatus = "planning" | "running" | "completed" | "failed";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";
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

export interface AgencyTask {
  id: string;
  description: string;
  assignedTo?: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface AgencyPlan {
  id: string;
  goal: string;
  tasks: AgencyTask[];
  agents: AgencyAgent[];
  createdAt: number;
  status: PlanStatus;
}

export interface AgencyMessage {
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: number;
}

export interface AgencyConfig {
  maxAgents: number;
  maxConcurrent: number;
  timeout: number;
  provider: string;
  model: string;
}

export interface AgencyStatus {
  planId: string;
  goal: string;
  status: PlanStatus;
  agents: AgencyAgent[];
  tasks: AgencyTask[];
  tokensUsed: number;
  apiCalls: number;
  elapsed: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksRemaining: number;
}

export interface AgencyResult {
  planId: string;
  goal: string;
  success: boolean;
  results: Map<string, string>;
  tokensUsed: number;
  apiCalls: number;
  elapsed: number;
  summary: string;
}

export interface DependencyGraph {
  nodes: string[];
  edges: Map<string, string[]>;
  order: string[];
}
