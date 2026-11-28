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
import { sendFrame } from "./frames.js";
import { OP_TYPE } from "../ops/op-types.js";
import { warmOpIndex } from "../ops/op-index.js";
import { basename } from "node:path";

export interface WorkersSnapshotSources {
  canonical: () => LiveWorker[];
  /** Autopilot runs keep their own registry (autopilot/loop.ts). */
  autopilot: () => { id: string; topic?: string }[];
  /** Named agents still running (agency/handler.ts). `parentAgentId` is the run
   *  that started one (a chunk worker's orchestrator): without it a reloaded
   *  page drew every chunk worker as its own card, and its orchestrator read
   *  STALLED while the worker ran (label-check, 2026-11-23). */
  agents: () => { id: string; name: string; task?: string; sessionId?: string; startedAt: number; parentAgentId?: string }[];
  /** Build orchestrators running in this process (auto-build/orchestrator/
   *  manager.ts). Neither a canonical op nor a named agent, so a snapshot
   *  without them ended every running build's card: label-check's orchestrator
   *  read "Completed" three minutes into its run (2026-11-23). Absent in a test
   *  that lists none. `stopping` is a build the owner has paused or cancelled
   *  that is still winding down: it is listed as what it was told to become.
   *  The snapshot is the answer to the Pause itself (agent-controls.ts), sent
   *  before the build has stopped, and it read "running": on a phone showing
   *  another chat, which never gets the build's own paused event, the card
   *  did not change at all (2026-11-26). */
  orchestrators?: () => { opId: string; projectDir: string; sessionId: string; startedAt: number; paused?: boolean; stopping?: "paused" | "cancelled" }[];
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
      ...(agent.parentAgentId ? { parentOpId: agent.parentAgentId } : {}),
    });
  }
  for (const orch of sources.orchestrators?.() ?? []) {
    // A cancelled build has ended for the owner: leaving it out ends its card.
    if (listed.has(orch.opId) || orch.stopping === "cancelled") continue;
    // The task the orchestrator card was started with (manager.ts bg_op_started).
    workers.push({
      opId: orch.opId, sessionId: orch.sessionId, task: `Build ${basename(orch.projectDir)}`, status: orch.paused || orch.stopping === "paused" ? "paused" : "running",
      opType: OP_TYPE.orchestrator, startedAt: new Date(orch.startedAt).toISOString(),
    });
  }
  return { type: "workers_snapshot", workers: withClaims(workers, sources.claims?.() ?? []) };
}

async function defaultSources(): Promise<WorkersSnapshotSources> {
  const [{ listLiveWorkers }, { listActiveAutopilotOps }, { Handler }, { workClaimRows }, { listActive: listActiveOrchestrations }, { listPausedBuilds }] = await Promise.all([
    import("../canonical-loop/index.js"),
    import("../autopilot/loop.js"),
    import("../agency/handler.js"),
    import("../routes/agents/work-claims.js"),
    import("../auto-build/orchestrator/manager.js"),
    import("../auto-build/orchestrator/run-control.js"),
  ]);
  return {
    claims: workClaimRows,
    canonical: listLiveWorkers,
    // A paused build is on disk, not running: its card stays, reading paused, with Resume.
    orchestrators: () => [...listActiveOrchestrations(), ...listPausedBuilds().map((b) => ({ ...b, paused: true }))],
    autopilot: () => listActiveAutopilotOps().map((op) => ({ id: op.id, topic: op.autopilot?.topic })),
    agents: () => (Handler.getInstance().getAgentStatus() as FieldAgentStatus[])
      .filter((a) => a.status !== "succeeded" && a.status !== "failed")
      .map((a) => ({ id: a.id, name: a.name, task: a.currentTask, sessionId: a.parentSessionId, startedAt: a.startedAt, parentAgentId: a.parentAgentId })),
  };
}

export async function sendWorkersSnapshot(ws: WebSocket, sources?: WorkersSnapshotSources): Promise<void> {
  // The live-worker listing asks the op index. While its first pass is still
  // running in the background (a server start), asking finishes the whole pass
  // in one go on this thread: 1.2 s in a start's profile, more with a bigger
  // op store. The snapshot waits for the pass instead; after it, this is free.
  if (!sources) await warmOpIndex();
  const frame = buildWorkersSnapshot(sources ?? await defaultSources());
  if (ws.readyState === 1 /* OPEN */) sendFrame(ws, frame);
}
