// Workers: the desktop's background jobs (app builds, delegated agents, autopilot), as
// its agents panel shows them. Carried on the `chat` data channel like chat.ts, but not
// scoped to one conversation: the desktop sends every worker event to every chat client,
// whichever session started the job.
//
// Live events arrive in one of two wrappings, and a client must read both:
//   - `{ type: "event", sessionId, event }`, the chat envelope, for in-process jobs;
//   - `{ type: "process_relay_delivery", sessionId, events: [...] }`, a batch, for jobs
//     that run in a child process.
// A client that connects mid-job has missed the job's start, and one that was offline
// has missed its end, so it asks for `workers_list` and the desktop answers with the
// full set of live workers (`workers_snapshot`): anything the client holds as live that
// the snapshot leaves out has ended.

import { asNumber, asRecord, asString, type Rec } from "./guards.js";

/** A live worker: waiting for a slot, working, or stopped mid-job. A paused worker
 *  was paused by the user; a blocked one waits on something (an approval); a stalled
 *  one stopped making progress. All three can be resumed. */
export type LiveWorkerStatus = "queued" | "running" | "paused" | "blocked" | "stalled";
/** How a worker ended. `partial`: it stopped at a checkpoint with its work unfinished. */
export type FinishedWorkerStatus = "completed" | "partial" | "failed" | "cancelled";
/** The statuses a progress event can move a worker to (it keeps its status otherwise). */
export type SuspendedWorkerStatus = Extract<LiveWorkerStatus, "paused" | "blocked" | "stalled">;

const SUSPENDED: readonly string[] = ["paused", "blocked", "stalled"];
const LIVE: readonly string[] = ["queued", "running", ...SUSPENDED];
const FINISHED: readonly string[] = ["completed", "partial", "failed", "cancelled"];

// ── desktop → phone ──

export type WorkerQueuedEvent = {
  type: "bg_op_queued";
  opId: string;
  task: string;
  /** The job that spawned this one, when it was delegated. */
  parentOpId?: string;
  /** What kind of job it is (app_build, agent_spawn, …). */
  opType?: string;
};
export type WorkerStartedEvent = {
  type: "bg_op_started";
  opId: string;
  task: string;
  parentOpId?: string;
  opType?: string;
  /** ISO time the job started, so elapsed time counts from the real start. */
  startedAt?: string;
};
/** One line of what the worker is doing. A `status` moves it to that status; a
 *  worker that goes back to work sends `bg_op_started` again. */
export type WorkerProgressEvent = {
  type: "bg_op_progress";
  opId: string;
  line: string;
  status?: SuspendedWorkerStatus;
  /** The job's running token total (input + output, every turn so far). */
  totalTokens?: number;
  /** The model that served the latest turn. */
  model?: string;
};
export type WorkerCompletedEvent = {
  type: "bg_op_completed";
  opId: string;
  status: FinishedWorkerStatus;
  summary: string;
  /** The job ran for a background session no one is chatting in (memory, skills). */
  headless?: boolean;
};

export type WorkerEvent = WorkerQueuedEvent | WorkerStartedEvent | WorkerProgressEvent | WorkerCompletedEvent;

/** A worker event and the conversation that started the job. */
export type WorkerEventFrame = { sessionId: string; event: WorkerEvent };

/** One live worker, as the snapshot reports it. */
export type WorkerSnapshot = {
  opId: string;
  /** The conversation that started the job. */
  sessionId: string;
  task: string;
  status: LiveWorkerStatus;
  opType?: string;
  parentOpId?: string;
  startedAt?: string;
  /** The latest line of what it is doing. */
  lastLine?: string;
  totalTokens?: number;
};

/** The answer to `workers_list`: every live worker, complete. */
export type WorkersSnapshotFrame = { type: "workers_snapshot"; workers: WorkerSnapshot[] };

// ── phone → desktop ──

/** Ask for a `workers_snapshot`. Send it on every new link: a fresh link holds none of
 *  the events sent while it was down. */
export type WorkersListFrame = { type: "workers_list" };

/** Pause, resume or cancel a worker. A worker the desktop can't do that to (one that
 *  already finished, an autopilot run asked to pause) gets a top-level `error` frame
 *  back (parseControlError). */
export type WorkerControlAction = "pause" | "resume" | "cancel";
export type AgentControlFrame = { type: "agent-control"; agentId: string; action: WorkerControlAction };

/** Give a running worker a new instruction; it takes it in at its next turn. */
export type AgentRedirectFrame = { type: "agent-redirect"; agentId: string; instruction: string };

export type WorkerOutboundFrame = WorkersListFrame | AgentControlFrame | AgentRedirectFrame;

/** The controls the desktop carries out for a worker, by its id. An autopilot run
 *  (`op_ap_…`) can only be stopped; the desktop answers anything else with an error.
 *  Every other worker can be paused, resumed, cancelled and redirected. */
export function workerControls(opId: string): { pause: boolean; cancel: boolean; redirect: boolean } {
  const autopilot = opId.startsWith("op_ap_");
  return { pause: !autopilot, cancel: true, redirect: !autopilot };
}

// ── parsers ──

function optionalString(raw: Rec, key: string): string | undefined {
  return asString(raw[key]) ?? undefined;
}

function parseWorkerEvent(raw: Rec): WorkerEvent | null {
  const opId = asString(raw.opId);
  if (opId === null) return null;
  switch (raw.type) {
    case "bg_op_queued":
    case "bg_op_started": {
      const task = asString(raw.task) ?? "";
      const parentOpId = optionalString(raw, "parentOpId");
      const opType = optionalString(raw, "opType");
      const lineage = { ...(parentOpId !== undefined ? { parentOpId } : {}), ...(opType !== undefined ? { opType } : {}) };
      if (raw.type === "bg_op_queued") return { type: "bg_op_queued", opId, task, ...lineage };
      const startedAt = optionalString(raw, "startedAt");
      return { type: "bg_op_started", opId, task, ...lineage, ...(startedAt !== undefined ? { startedAt } : {}) };
    }
    case "bg_op_progress": {
      const line = asString(raw.line);
      if (line === null) return null;
      const ev: WorkerProgressEvent = { type: "bg_op_progress", opId, line };
      if (typeof raw.status === "string" && SUSPENDED.includes(raw.status)) ev.status = raw.status as SuspendedWorkerStatus;
      const totalTokens = asNumber(raw.totalTokens);
      if (totalTokens !== null) ev.totalTokens = totalTokens;
      const model = asString(raw.model);
      if (model) ev.model = model;
      return ev;
    }
    case "bg_op_completed": {
      if (typeof raw.status !== "string" || !FINISHED.includes(raw.status)) return null;
      const ev: WorkerCompletedEvent = {
        type: "bg_op_completed",
        opId,
        status: raw.status as FinishedWorkerStatus,
        summary: asString(raw.summary) ?? "",
      };
      if (raw.headless === true) ev.headless = true;
      return ev;
    }
    default:
      return null;
  }
}

/** The worker events in an inbound chat-channel frame, from either wrapping, for any
 *  session. Empty for every other frame and for events this contract does not model. */
export function parseWorkerFrames(raw: unknown): WorkerEventFrame[] {
  const msg = asRecord(raw);
  const sessionId = msg === null ? null : asString(msg.sessionId);
  if (msg === null || sessionId === null) return [];
  const events = msg.type === "event" ? [msg.event] : msg.type === "process_relay_delivery" && Array.isArray(msg.events) ? msg.events : [];
  const out: WorkerEventFrame[] = [];
  for (const candidate of events) {
    const rec = asRecord(candidate);
    const event = rec === null ? null : parseWorkerEvent(rec);
    if (event !== null) out.push({ sessionId, event });
  }
  return out;
}

function parseWorkerSnapshot(raw: unknown): WorkerSnapshot | null {
  const rec = asRecord(raw);
  if (rec === null) return null;
  const opId = asString(rec.opId);
  const sessionId = asString(rec.sessionId);
  if (opId === null || sessionId === null || typeof rec.status !== "string" || !LIVE.includes(rec.status)) return null;
  const snap: WorkerSnapshot = { opId, sessionId, task: asString(rec.task) ?? "", status: rec.status as LiveWorkerStatus };
  for (const key of ["opType", "parentOpId", "startedAt", "lastLine"] as const) {
    const value = optionalString(rec, key);
    if (value !== undefined) snap[key] = value;
  }
  const totalTokens = asNumber(rec.totalTokens);
  if (totalTokens !== null) snap.totalTokens = totalTokens;
  return snap;
}

/** A `workers_snapshot` frame, or null for any other frame. A malformed entry is
 *  dropped, not the snapshot. */
export function parseWorkersSnapshot(raw: unknown): WorkersSnapshotFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "workers_snapshot" || !Array.isArray(msg.workers)) return null;
  const workers: WorkerSnapshot[] = [];
  for (const entry of msg.workers) {
    const snap = parseWorkerSnapshot(entry);
    if (snap !== null) workers.push(snap);
  }
  return { type: "workers_snapshot", workers };
}

/** The message of a top-level `error` frame: how the desktop's chat socket answers a
 *  control it could not carry out. Chat errors arrive inside an `event` envelope
 *  instead (chat.ts), so they never match here. */
export function parseControlError(raw: unknown): string | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "error" || "sessionId" in msg) return null;
  return asString(msg.message);
}
