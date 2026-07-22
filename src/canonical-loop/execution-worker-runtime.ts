import { join } from "node:path";
import { startAriKernel } from "../ari-kernel/index.js";
import { getRuntimeConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { readOp } from "../ops/op-store.js";
import { getOrInitSecretsStore } from "../secrets.js";
import { setSessionRelayWriter } from "../ops/session-bridge.js";
import { buildToolRegistry } from "../tools.js";
import {
  heartbeatProcessExecutionClaim,
  processClaimMatches,
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
  type ExecutionOwnerClaim,
} from "./process-execution-claim.js";
import { startProcessControlRelay } from "./process-control-relay.js";
import { startContainerLineageForwarding } from "../browser/container-taint-forward.js";
import {
  appendProcessRelayRecord,
  backfillCanonicalRelayTail,
  initializeProcessRelayJournal,
} from "./process-relay-journal.js";
import type { ProcessRelayNotice } from "./process-relay-contract.js";
import { setProcessRelayOutputWriter } from "./process-relay-output.js";
import { rehydrateRecoveredRuntime, resolveAdapterFactory } from "./runtime.js";
import { runWorker } from "./worker.js";

export class ExecutionWorkerIdentityError extends Error {}

export async function runClaimedExecutionWorker(
  expected: ExecutionOwnerClaim,
  onNotice: (notice: ProcessRelayNotice) => void = () => {},
  onOwnershipLost: () => void = () => {},
): Promise<void> {
  const durable = readProcessExecutionClaim(expected.opId);
  if (!durable || !processClaimMatches(durable, expected)) {
    throw new ExecutionWorkerIdentityError("durable execution owner changed");
  }
  const op = readOp(expected.opId);
  const placement = op?.canonical?.executionPlacement;
  if (!op || placement?.backendId !== expected.backendId
    || placement.targetId !== expected.targetId
    || placement.revision !== expected.placementRevision
    || placement.disposition !== "ready") {
    throw new ExecutionWorkerIdentityError("durable execution placement changed");
  }
  const sessionId = op.canonical?.sessionId;
  if (!sessionId) throw new ExecutionWorkerIdentityError("execution session identity is missing");

  let heartbeat: NodeJS.Timeout | undefined;
  let ownershipLost = false;
  const stopControl = startProcessControlRelay(op.id);
  // Forward this process's sensitive-read taint / canaries to the host when the
  // browser relay is active (container browsing) — no-op otherwise, so host-side
  // execution is unaffected. Keeps the host page-egress scan from being blind to
  // taint accrued inside the container (audit finding 5).
  const stopLineageForwarding = startContainerLineageForwarding();
  try {
    initializeProcessRelayJournal(expected, sessionId);
    setProcessRelayOutputWriter((kind, payload) => {
      const notice = appendProcessRelayRecord(expected, sessionId, kind, payload);
      onNotice(notice);
      return notice;
    });
    setSessionRelayWriter((targetSessionId, event) => {
      if (targetSessionId !== sessionId) throw new ExecutionWorkerIdentityError("relay session changed");
      const notice = appendProcessRelayRecord(expected, sessionId, "session-event", event);
      onNotice(notice);
    });
    for (const notice of backfillCanonicalRelayTail(expected, sessionId)) onNotice(notice);
    heartbeat = setInterval(() => {
      if (!heartbeatProcessExecutionClaim(expected, new Date().toISOString())) {
        ownershipLost = true;
        onOwnershipLost();
      }
    }, 2_000);
    heartbeat.unref?.();
    const config = getRuntimeConfig();
    const kernelActive = await startAriKernel(
      join(getLaxDir(), "ari-audit.db"),
      undefined,
      config.ariRequired,
    );
    if (!kernelActive && config.ariRequired) {
      throw new Error("execution worker security kernel is unavailable");
    }
    if (!process.env.LAX_SCOPED_RUNTIME_CREDENTIAL_FILE) {
      getOrInitSecretsStore(getLaxDir());
    }
    buildToolRegistry();
    rehydrateRecoveredRuntime(op);
    const factory = resolveAdapterFactory(op);
    if (!factory) throw new Error("execution adapter is unavailable");
    const adapter = await factory();
    await runWorker(op, adapter).done;
    if (ownershipLost || !removeProcessExecutionClaim(expected)) {
      throw new ExecutionWorkerIdentityError("execution ownership was lost before completion");
    }
  } catch (error) {
    removeProcessExecutionClaim(expected);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    stopLineageForwarding();
    stopControl();
    setProcessRelayOutputWriter(null);
    setSessionRelayWriter(null);
  }
}
