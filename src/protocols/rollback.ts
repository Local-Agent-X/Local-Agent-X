/**
 * Protocol Rollback — records state before each step and can undo.
 */

import type { ToolDefinition } from "../types.js";

export interface StateSnapshot {
  stepId: string;
  timestamp: number;
  state: Record<string, unknown>;
  description: string;
}

export interface RollbackSession {
  executionId: string;
  protocolName: string;
  snapshots: StateSnapshot[];
  currentIndex: number;
  rolledBack: boolean;
}

const sessions = new Map<string, RollbackSession>();

export function createRollbackSession(executionId: string, protocolName: string): RollbackSession {
  const session: RollbackSession = {
    executionId,
    protocolName,
    snapshots: [],
    currentIndex: -1,
    rolledBack: false,
  };
  sessions.set(executionId, session);
  return session;
}

export function saveSnapshot(executionId: string, stepId: string, state: Record<string, unknown>, description: string): StateSnapshot | null {
  const session = sessions.get(executionId);
  if (!session) return null;

  const snapshot: StateSnapshot = {
    stepId,
    timestamp: Date.now(),
    state: structuredClone(state),
    description,
  };

  session.snapshots.push(snapshot);
  session.currentIndex = session.snapshots.length - 1;
  return snapshot;
}

export function rollbackToStep(executionId: string, stepId: string): StateSnapshot | null {
  const session = sessions.get(executionId);
  if (!session) return null;

  const idx = session.snapshots.findIndex(s => s.stepId === stepId);
  if (idx === -1) return null;

  session.currentIndex = idx;
  session.rolledBack = true;
  session.snapshots = session.snapshots.slice(0, idx + 1);

  return session.snapshots[idx];
}

export function rollbackLast(executionId: string): StateSnapshot | null {
  const session = sessions.get(executionId);
  if (!session || session.snapshots.length === 0) return null;

  if (session.currentIndex > 0) {
    session.currentIndex--;
    session.rolledBack = true;
    session.snapshots = session.snapshots.slice(0, session.currentIndex + 1);
    return session.snapshots[session.currentIndex];
  }

  return session.snapshots[0];
}

export function getSnapshots(executionId: string): StateSnapshot[] {
  return sessions.get(executionId)?.snapshots ?? [];
}

export function getSession(executionId: string): RollbackSession | undefined {
  return sessions.get(executionId);
}

export function createRollbackTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_rollback_init",
      description: "Initialize rollback tracking for a protocol execution.",
      parameters: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          protocolName: { type: "string" },
        },
        required: ["executionId", "protocolName"],
      },
      async execute(args) {
        const session = createRollbackSession(String(args.executionId), String(args.protocolName));
        return { content: `Rollback tracking initialized for ${session.protocolName} [${session.executionId}].` };
      },
    },
    {
      name: "protocol_rollback_snapshot",
      description: "Save a state snapshot before executing a protocol step.",
      parameters: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          stepId: { type: "string" },
          state: { type: "object", description: "Current state to preserve" },
          description: { type: "string", description: "What this snapshot captures" },
        },
        required: ["executionId", "stepId", "state", "description"],
      },
      async execute(args) {
        const snap = saveSnapshot(
          String(args.executionId),
          String(args.stepId),
          args.state as Record<string, unknown>,
          String(args.description)
        );
        if (!snap) return { content: "Rollback session not found." };
        return { content: `Snapshot saved for step "${snap.stepId}": ${snap.description}` };
      },
    },
    {
      name: "protocol_rollback_undo",
      description: "Roll back to a previous step's state.",
      parameters: {
        type: "object",
        properties: {
          executionId: { type: "string" },
          stepId: { type: "string", description: "Step ID to roll back to (omit for last step)" },
        },
        required: ["executionId"],
      },
      async execute(args) {
        const execId = String(args.executionId);
        const snap = args.stepId
          ? rollbackToStep(execId, String(args.stepId))
          : rollbackLast(execId);

        if (!snap) return { content: "No snapshot found to roll back to." };
        return {
          content: `Rolled back to step "${snap.stepId}" (${new Date(snap.timestamp).toISOString()}).\nRestored state: ${JSON.stringify(snap.state, null, 2)}`,
        };
      },
    },
    {
      name: "protocol_rollback_history",
      description: "View all saved snapshots for a protocol execution.",
      parameters: {
        type: "object",
        properties: { executionId: { type: "string" } },
        required: ["executionId"],
      },
      async execute(args) {
        const snapshots = getSnapshots(String(args.executionId));
        if (snapshots.length === 0) return { content: "No snapshots recorded." };
        const list = snapshots.map((s, i) =>
          `${i + 1}. [${s.stepId}] ${s.description} — ${new Date(s.timestamp).toISOString()}`
        ).join("\n");
        return { content: `Snapshots:\n${list}` };
      },
    },
  ];
}
