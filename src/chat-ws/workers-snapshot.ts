// The workers_list frame: answer ONE socket with every live worker the AGENTS
// sidebar would show, complete. A client builds its worker list from the
// bg_op_* events, so one that connected mid-job never saw the job start and one
// that was offline never saw it end; the snapshot is the whole live set, and a
// worker the client holds as live but the snapshot leaves out has ended.
//
// The frame's shape is the phone↔desktop contract (agentxos workers.ts), typed
// from the vendored copy so a drift from it fails the build here.

import type { WebSocket } from "ws";
import type { WorkerSnapshot, WorkersSnapshotFrame } from "../broker-transport/vendor/protocol.js";
import type { LiveWorker } from "../canonical-loop/index.js";

export interface WorkersSnapshotSources {
  canonical: () => LiveWorker[];
  /** Autopilot runs keep their own registry (autopilot/loop.ts). */
  autopilot: () => { id: string; topic?: string }[];
}

export function buildWorkersSnapshot(sources: WorkersSnapshotSources): WorkersSnapshotFrame {
  const workers: WorkerSnapshot[] = sources.canonical();
  const listed = new Set(workers.map((w) => w.opId));
  for (const run of sources.autopilot()) {
    if (listed.has(run.id)) continue;
    // The same session id the connect-time autopilot replay uses (connection-setup.ts).
    workers.push({ opId: run.id, sessionId: "autopilot", task: run.topic || "Autopilot", status: "running" });
  }
  return { type: "workers_snapshot", workers };
}

async function defaultSources(): Promise<WorkersSnapshotSources> {
  const [{ listLiveWorkers }, { listActiveAutopilotOps }] = await Promise.all([
    import("../canonical-loop/index.js"),
    import("../autopilot/loop.js"),
  ]);
  return {
    canonical: listLiveWorkers,
    autopilot: () => listActiveAutopilotOps().map((op) => ({ id: op.id, topic: op.autopilot?.topic })),
  };
}

export async function sendWorkersSnapshot(ws: WebSocket, sources?: WorkersSnapshotSources): Promise<void> {
  const frame = buildWorkersSnapshot(sources ?? await defaultSources());
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(frame));
}
