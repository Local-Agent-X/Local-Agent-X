/**
 * Worker sessions — long-lived chat sessions scoped to a working directory.
 *
 * Solves the IDE-app-builder problem: when the user wants the agent to keep
 * editing an app, we don't want to spawn a sub-agent in a worktree (writes
 * get lost on cleanup) and we don't want the main agent to block on the work
 * (the user can't talk while it runs). Instead, the main agent acts as a
 * thin router that dispatches to a worker session — a separate session that
 * lives in a real directory (not a worktree) and persists across messages.
 *
 * This module is the foundation. It owns the registry and the dispatch API.
 * The actual chat loop is reused from the main agent path (the worker session
 * is just another sessionId from the executor's point of view, but bound to
 * a specific cwd and a stable identity).
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export interface WorkerSession {
  /** Stable session id used by the executor (e.g. "worker-app-todo-list"). */
  id: string;
  /** Absolute path the worker is scoped to. All writes happen here. */
  workingDir: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Unix ms of last user message. */
  lastActivity: number;
  /** Whether a dispatch is currently in flight. */
  busy: boolean;
  /** Last status message reported by the worker. */
  status: string;
}

const sessions = new Map<string, WorkerSession>();

function makeId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `worker-${slug || "session"}`;
}

/**
 * Create or fetch a worker session for a given working directory.
 * The directory must already exist — we never create it implicitly.
 */
export function getOrCreateWorkerSession(workingDir: string, label?: string): WorkerSession {
  const absDir = resolvePath(workingDir);
  if (!existsSync(absDir)) {
    throw new Error(`Worker session workingDir does not exist: ${absDir}`);
  }
  const displayLabel = label || absDir.split(/[\\/]/).pop() || "session";
  const id = makeId(displayLabel);

  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      workingDir: absDir,
      label: displayLabel,
      lastActivity: Date.now(),
      busy: false,
      status: "idle",
    };
    sessions.set(id, session);
  }
  return session;
}

export function listWorkerSessions(): WorkerSession[] {
  return [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

export function getWorkerSession(id: string): WorkerSession | undefined {
  return sessions.get(id);
}

export function endWorkerSession(id: string): boolean {
  return sessions.delete(id);
}

/**
 * Mark a worker session as busy with a dispatch. Caller is responsible for
 * calling `markIdle` when the dispatch completes (success or failure).
 *
 * Returns false if the session is already busy — the caller should reject
 * the dispatch or queue it.
 */
export function markBusy(id: string, status: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.busy) return false;
  s.busy = true;
  s.status = status;
  s.lastActivity = Date.now();
  return true;
}

export function markIdle(id: string, status: string = "idle"): void {
  const s = sessions.get(id);
  if (!s) return;
  s.busy = false;
  s.status = status;
  s.lastActivity = Date.now();
}

/**
 * Dispatch interface — the actual work is done by the runner (which closes
 * over a real chat session loop). This module just owns the lifecycle and
 * the busy/idle state machine; runners are wired in from server.ts where
 * the agent loop and tool registry are available.
 */
export type WorkerRunner = (session: WorkerSession, message: string) => Promise<string>;

let registeredRunner: WorkerRunner | null = null;

export function registerWorkerRunner(runner: WorkerRunner): void {
  registeredRunner = runner;
}

/**
 * Send a message to a worker session. Returns the worker's reply.
 * Throws if no runner has been registered or the session is busy.
 */
export async function dispatchToWorker(id: string, message: string): Promise<string> {
  if (!registeredRunner) {
    throw new Error("No worker runner registered. Wire registerWorkerRunner() at server startup.");
  }
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Unknown worker session: ${id}`);
  }
  if (!markBusy(id, "running")) {
    throw new Error(`Worker session ${id} is already busy. Wait for it to finish or open a second worker.`);
  }
  try {
    const reply = await registeredRunner(session, message);
    markIdle(id, "idle");
    return reply;
  } catch (e) {
    markIdle(id, `error: ${(e as Error).message}`);
    throw e;
  }
}
