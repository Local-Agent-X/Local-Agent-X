import { runClaimedExecutionWorker } from "./execution-worker-runtime.js";
import {
  processClaimMatches,
  removeProcessExecutionClaim,
  type ProcessClaimIdentity,
  type ProcessExecutionClaim,
} from "./process-execution-claim.js";

const opId = required("LAX_PROCESS_OP_ID");
const backendId = required("LAX_PROCESS_BACKEND_ID");
const targetId = required("LAX_PROCESS_TARGET_ID");
const token = required("LAX_PROCESS_HANDOFF_TOKEN");
const placementRevision = Number(required("LAX_PROCESS_PLACEMENT_REVISION"));
const processStartedAt = new Date().toISOString();
const identity: ProcessClaimIdentity = {
  opId,
  backendId,
  targetId,
  placementRevision,
  token,
  pid: process.pid,
  processStartedAt,
};

if (!Number.isSafeInteger(placementRevision) || placementRevision < 1) process.exit(2);
send({ type: "ready", token, pid: process.pid, processStartedAt });

let started = false;
let finishing = false;
const handoffTimer = setTimeout(() => fail(2), 60_000);
handoffTimer.unref?.();

process.once("disconnect", () => {
  if (!finishing) fail(started ? 9 : 2);
});
process.once("message", message => {
  const envelope = message as { type?: unknown; claim?: unknown } | null;
  if (envelope?.type !== "start") return fail(2);
  let claim: ProcessExecutionClaim;
  try {
    claim = envelope.claim as ProcessExecutionClaim;
    if (!processClaimMatches(claim, identity)) return fail(3);
  } catch {
    return fail(3);
  }
  started = true;
  clearTimeout(handoffTimer);
  void run(claim);
});

async function run(expected: ProcessExecutionClaim): Promise<void> {
  try {
    if (!processClaimMatches(expected, identity)) return fail(3);
    await runClaimedExecutionWorker(expected, send, () => fail(6));
    finish(0);
  } catch {
    finish(8);
  }
}

function send(message: unknown): void {
  if (!process.connected || !process.send) return fail(2);
  try {
    process.send(message, error => {
      if (error) fail(2);
    });
  } catch {
    fail(2);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function fail(code: number): void {
  removeProcessExecutionClaim(identity);
  finish(code);
}

function finish(code: number): void {
  if (finishing) return;
  finishing = true;
  process.exitCode = code;
  if (process.connected) process.disconnect?.();
  setImmediate(() => process.exit(code));
}
