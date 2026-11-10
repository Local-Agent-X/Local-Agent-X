// The workers_list frame: answer ONE socket with every live worker the AGENTS
// sidebar would show, complete. A client builds its worker list from the
// bg_op_* events, so one that connected mid-job never saw the job start and one
// that was offline never saw it end; the snapshot is the whole live set, and a
// worker the client holds as live but the snapshot leaves out has ended. Named
// agents (agent_spawn) are listed by their agent id, the id their card carries:
// their op is suppressed from the canonical listing because handler-events
// draws their card, so without them a dead agent's card had nothing to end it.
//
// The frame's shape is the phone↔desktop contract (agentxos workers.ts), typed
// from the vendored copy so a drift from it fails the build here.

import type { WebSocket } from "ws";
import type { WorkerSnapshot, WorkersSnapshotFrame } from "../broker-transport/vendor/protocol.js";
import type { LiveWorker } from "../canonical-loop/index.js";
import type { FieldAgentStatus } from "../agency/handler-types.js";

export interface WorkersSnapshotSources {
  canonical: () => LiveWorker[];
  /** Autopilot runs keep their own registry (autopilot/loop.ts). */
  autopilot: () => { id: string; topic?: string }[];
  /** Named agents still running (agency/handler.ts). */
  agents: () => { id: string; name: string; task?: string; sessionId?: string; startedAt: number }[];
  /** What each agent is changing and who else is in the same files
   *  (routes/agents/work-claims.ts); absent in a test that lists none. */
  claims?: () => { sessionId: string; opId: string | null; areas: string[]; clashesWith: string[] }[];
}

/** Put each worker's areas and clashes on its row: a worker is the holder
 *  whose op it is, or whose session is the named agent's (`agent-<id>`). */
function withClaims(workers: WorkerSnapshot[], claims: NonNullable<ReturnType<NonNullable<WorkersSnapshotSources["claims"]>>>): WorkerSnapshot[] {
  if (claims.length === 0) return workers;
  return workers.map((w) => {
    const row = claims.find((c) => c.opId === w.opId || c.sessionId === `agent-${w.opId}`);
    if (!row) return w;
    return {
      ...w,
      ...(row.areas.length ? { areas: row.areas } : {}),
      ...(row.clashesWith.length ? { clashesWith: row.clashesWith } : {}),
    };
  });
}

export function buildWorkersSnapshot(sources: WorkersSnapshotSources): WorkersSnapshotFrame {
  const workers: WorkerSnapshot[] = sources.canonical();
  const listed = new Set(workers.map((w) => w.opId));
  for (const run of sources.autopilot()) {
    if (listed.has(run.id)) continue;
    // The same session id the connect-time autopilot replay uses (connection-setup.ts).
    workers.push({ opId: run.id, sessionId: "autopilot", task: run.topic || "Autopilot", status: "running" });
  }
  for (const agent of sources.agents()) {
    if (listed.has(agent.id)) continue;
    workers.push({
      opId: agent.id, sessionId: agent.sessionId ?? "", task: agent.task || agent.name, status: "running",
      opType: "agent_spawn", startedAt: new Date(agent.startedAt).toISOString(),
    });
  }
  return { type: "workers_snapshot", workers: withClaims(workers, sources.claims?.() ?? []) };
}

async function defaultSources(): Promise<WorkersSnapshotSources> {
  const [{ listLiveWorkers }, { listActiveAutopilotOps }, { Handler }, { workClaimRows }] = await Promise.all([
    import("../canonical-loop/index.js"),
    import("../autopilot/loop.js"),
    import("../agency/handler.js"),
    import("../routes/agents/work-claims.js"),
  ]);
  return {
    claims: workClaimRows,
    canonical: listLiveWorkers,
    autopilot: () => listActiveAutopilotOps().map((op) => ({ id: op.id, topic: op.autopilot?.topic })),
    agents: () => (Handler.getInstance().getAgentStatus() as FieldAgentStatus[])
      .filter((a) => a.status !== "succeeded" && a.status !== "failed")
      .map((a) => ({ id: a.id, name: a.name, task: a.currentTask, sessionId: a.parentSessionId, startedAt: a.startedAt })),
  };
}

export async function sendWorkersSnapshot(ws: WebSocket, sources?: WorkersSnapshotSources): Promise<void> {
  const frame = buildWorkersSnapshot(sources ?? await defaultSources());
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(frame));
}
