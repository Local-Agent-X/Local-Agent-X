/**
 * Protocol Rollback — records state before each step and can undo.
 *
 * A snapshot keeps two things: the caller-supplied `state` (echoed back on
 * undo for the model to re-apply) and the execution's progress tracker as it
 * stood when the snapshot was taken (progress.ts, keyed by the same
 * executionId). Undo restores that progress, so the execution really is back
 * at the snapshot's step — later steps return to pending and the current
 * step index rewinds — rather than only printing the snapshot.
 */

import type { ToolDefinition } from "../types.js";
import { type ProtocolProgress, restoreProgress, snapshotProgress } from "./progress.js";

export interface StateSnapshot {
  stepId: string;
  timestamp: number;
  state: Record<string, unknown>;
  description: string;
  /** Execution progress at snapshot time; absent when no execution was being
   *  tracked under this id (rollback_init without progress_start). */
  progress?: ProtocolProgress;
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

  const progress = snapshotProgress(executionId);
  const snapshot: StateSnapshot = {
    stepId,
    timestamp: Date.now(),
    state: structuredClone(state),
    description,
    ...(progress ? { progress } : {}),
  };

  session.snapshots.push(snapshot);
  session.currentIndex = session.snapshots.length - 1;
  return snapshot;
}

function restoreTo(session: RollbackSession, idx: number): StateSnapshot {
  session.currentIndex = idx;
  session.rolledBack = true;
  session.snapshots = session.snapshots.slice(0, idx + 1);
  const snapshot = session.snapshots[idx];
  if (snapshot.progress) restoreProgress(snapshot.progress);
  return snapshot;
}

export function rollbackToStep(executionId: string, stepId: string): StateSnapshot | null {
  const session = sessions.get(executionId);
  if (!session) return null;

  const idx = session.snapshots.findIndex(s => s.stepId === stepId);
  if (idx === -1) return null;

  return restoreTo(session, idx);
}

export function rollbackLast(executionId: string): StateSnapshot | null {
  const session = sessions.get(executionId);
  if (!session || session.snapshots.length === 0) return null;

  return restoreTo(session, Math.max(0, session.currentIndex - 1));
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
      description: "Save a state snapshot before executing a protocol step. Also captures the execution's progress (protocol_progress_*) so rollback_undo can rewind it.",
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
      description: "Roll back to a previous step's snapshot: the execution's progress is rewound to that step (later steps become pending again) and the saved state is returned for you to re-apply.",
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
        const progressNote = snap.progress
          ? `Execution progress rewound: step ${snap.progress.currentStepIndex + 1}/${snap.progress.steps.length} (${snap.progress.status}).`
          : "No execution progress was tracked for this id; only the saved state is returned.";
        return {
          content: `Rolled back to step "${snap.stepId}" (${new Date(snap.timestamp).toISOString()}).\n${progressNote}\nRestored state: ${JSON.stringify(snap.state, null, 2)}`,
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
