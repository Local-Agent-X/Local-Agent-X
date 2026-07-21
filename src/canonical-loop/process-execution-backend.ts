import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import type {
  ExecutionBackend,
  ExecutionBackendStartRequest,
  ExecutionBackendStartWithoutAdapterRequest,
  ExecutionHandle,
} from "./execution-backend.js";
import type { ExecutionPlacement } from "./types.js";
import { notifyProcessRelayParent } from "./process-relay-parent-hook.js";
import type { ProcessRelayNotice } from "./process-relay-contract.js";
import {
  claimProcessExecution,
  isLiveProcessExecutionClaim,
  readProcessExecutionClaim,
  removeProcessExecutionClaim,
  type ProcessClaimIdentity,
  type ProcessExecutionClaim,
} from "./process-execution-claim.js";

export const PROCESS_EXECUTION_BACKEND_ID = "local-process";
export const PROCESS_EXECUTION_TARGET_ID = "canonical-worker-process-v1";
const READY_TIMEOUT_MS = 60_000;
const START_SKEW_MS = 5_000;

export interface ProcessBackendOptions {
  entryPath?: string;
  execArgv?: string[];
  now?: () => number;
  spawn?: typeof fork;
  isPidAlive?: (pid: number) => boolean;
  readyTimeoutMs?: number;
  onRelayNotice?: (notice: ProcessRelayNotice) => void;
  onFinalReconcile?: (opId: string) => void;
}

interface ReadyMessage {
  type: "ready";
  token: string;
  pid: number;
  processStartedAt: string;
}

export class ProcessExecutionBackend implements ExecutionBackend {
  readonly id = PROCESS_EXECUTION_BACKEND_ID;
  readonly adapterProvisioning = "backend" as const;
  private readonly entryPath: string;
  private readonly execArgv: string[] | undefined;
  private readonly now: () => number;
  private readonly spawn: typeof fork;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly readyTimeoutMs: number;
  private readonly onRelayNotice: (notice: ProcessRelayNotice) => void;
  private readonly onFinalReconcile: (opId: string) => void;

  constructor(options: ProcessBackendOptions = {}) {
    this.entryPath = options.entryPath ?? defaultEntryPath();
    this.execArgv = options.execArgv;
    this.now = options.now ?? Date.now;
    this.spawn = options.spawn ?? fork;
    this.pidAlive = options.isPidAlive ?? isPidAlive;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.onRelayNotice = options.onRelayNotice ?? notifyProcessRelayParent;
    this.onFinalReconcile = options.onFinalReconcile ?? notifyProcessRelayParent;
  }

  static isEligible(op: Op): boolean {
    const descriptor = op.runtimeDescriptor;
    return (op.lane === "background" || op.lane === "agent")
      && isExactDelegatedRuntime(descriptor)
      && !!descriptor.sessionId
      && descriptor.surface?.kind === "agent-runner"
      && op.canonical?.sessionId === descriptor.sessionId
      && op.type !== "chat_turn"
      && op.type !== "voice_turn"
      && !op.type.startsWith("app_build")
      && !op.type.startsWith("build_app");
  }

  place(_op: Op): { targetId: string; disposition: "ready" } {
    return { targetId: PROCESS_EXECUTION_TARGET_ID, disposition: "ready" };
  }

  acceptsPlacement(placement: ExecutionPlacement): boolean {
    return placement.backendId === this.id
      && placement.targetId === PROCESS_EXECUTION_TARGET_ID;
  }

  start(_request: ExecutionBackendStartRequest): ExecutionHandle {
    throw new Error("process backend provisions its adapter in the child process");
  }

  startWithoutAdapter(request: ExecutionBackendStartWithoutAdapterRequest): ExecutionHandle {
    this.assertEligible(request.op, request.placement);
    this.reclaimDeadClaim(request.op.id);
    const token = randomUUID();
    const spawnedAt = this.now();
    const child = this.spawn(this.entryPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      execArgv: this.execArgv,
      env: {
        ...process.env,
        LAX_PROCESS_OP_ID: request.op.id,
        LAX_PROCESS_BACKEND_ID: this.id,
        LAX_PROCESS_TARGET_ID: request.placement.targetId,
        LAX_PROCESS_PLACEMENT_REVISION: String(request.placement.revision),
        LAX_PROCESS_HANDOFF_TOKEN: token,
      },
    });
    return {
      done: handoffAndWait({
        child,
        opId: request.op.id,
        backendId: this.id,
        placement: request.placement,
        token,
        spawnedAt,
        now: this.now,
        readyTimeoutMs: this.readyTimeoutMs,
        onRelayNotice: this.onRelayNotice,
        onFinalReconcile: this.onFinalReconcile,
      }),
    };
  }

  private assertEligible(op: Op, placement: ExecutionPlacement): void {
    if (!this.acceptsPlacement(placement) || placement.disposition !== "ready") {
      throw new Error("process execution placement identity mismatch");
    }
    if (!ProcessExecutionBackend.isEligible(op)) {
      throw new Error("operation is not eligible for process execution");
    }
  }

  private reclaimDeadClaim(opId: string): void {
    const existing = readProcessExecutionClaim(opId);
    if (!existing) return;
    if (isLiveProcessExecutionClaim(existing, { now: this.now, isPidAlive: this.pidAlive })) {
      throw new Error("operation already has a live process owner");
    }
    if (!removeProcessExecutionClaim(existing)) {
      throw new Error("process ownership changed during reclaim");
    }
  }
}

interface HandoffInput {
  child: ChildProcess;
  opId: string;
  backendId: string;
  placement: ExecutionPlacement;
  token: string;
  spawnedAt: number;
  now: () => number;
  readyTimeoutMs: number;
  onRelayNotice: (notice: ProcessRelayNotice) => void;
  onFinalReconcile: (opId: string) => void;
}

function handoffAndWait(input: HandoffInput): Promise<void> {
  const { child, opId, backendId, placement, token, spawnedAt, now } = input;
  return new Promise((resolve, reject) => {
    let settled = false;
    let handoffSent = false;
    let claim: ProcessExecutionClaim | null = null;
    const handoffTimer = setTimeout(
      () => fail(new Error("process worker handoff timed out")),
      input.readyTimeoutMs,
    );
    handoffTimer.unref?.();

    const cleanupClaim = () => {
      if (claim) removeProcessExecutionClaim(claim);
    };
    const cleanupListeners = () => {
      clearTimeout(handoffTimer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      cleanupClaim();
      try { input.onFinalReconcile(opId); } catch { /* durable relay stays pending */ }
      try { child.kill(); } catch { /* already gone */ }
      reject(error);
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      cleanupClaim();
      try { input.onFinalReconcile(opId); } catch { /* startup janitor retries */ }
      resolve();
    };
    const onError = (error: Error) => fail(error);
    const onDisconnect = () => {
      if (!handoffSent) fail(new Error("process worker disconnected before durable handoff"));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!handoffSent) {
        fail(new Error("process worker exited before durable handoff"));
      } else if (code !== 0) {
        fail(new Error(`process worker exited before completion (${code ?? signal})`));
      } else {
        complete();
      }
    };
    const onMessage = (value: unknown) => {
      if (settled) return;
      if (claim) {
        const notice = value as Partial<ProcessRelayNotice> | null;
        if (notice?.type === "process-relay" && notice.opId === opId
          && typeof notice.generationId === "string" && Number.isSafeInteger(notice.cursor)) {
          try { input.onRelayNotice(notice as ProcessRelayNotice); } catch { /* durable relay stays pending */ }
        }
        return;
      }
      const ready = parseReady(value, child.pid, token, spawnedAt, now());
      if (!ready) {
        const message = value as { type?: unknown } | null;
        if (message?.type === "ready") {
          fail(new Error("process worker returned an ambiguous handoff identity"));
        }
        return;
      }
      claim = {
        schemaVersion: 1,
        opId,
        backendId,
        targetId: placement.targetId,
        placementRevision: placement.revision,
        token,
        pid: ready.pid,
        processStartedAt: ready.processStartedAt,
        heartbeatAt: new Date(now()).toISOString(),
      };
      if (!claimProcessExecution(claim)) {
        fail(new Error("process ownership changed during durable handoff"));
        return;
      }
      if (!child.send) {
        fail(new Error("process worker IPC channel is unavailable"));
        return;
      }
      try {
        child.send({ type: "start", claim }, error => {
          if (error) {
            fail(new Error(`process worker handoff send failed: ${error.message}`));
            return;
          }
          clearTimeout(handoffTimer);
          handoffSent = true;
        });
      } catch (error) {
        fail(error as Error);
      }
    };

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
  });
}

function parseReady(
  value: unknown,
  childPid: number | undefined,
  token: string,
  spawnedAt: number,
  now: number,
): ReadyMessage | null {
  const ready = value as Partial<ReadyMessage> | null;
  if (!ready || ready.type !== "ready" || ready.token !== token
    || !Number.isSafeInteger(ready.pid) || ready.pid !== childPid
    || typeof ready.processStartedAt !== "string") return null;
  const startedAt = Date.parse(ready.processStartedAt);
  if (!Number.isFinite(startedAt)
    || new Date(startedAt).toISOString() !== ready.processStartedAt
    || startedAt < spawnedAt - START_SKEW_MS
    || startedAt > now + START_SKEW_MS) return null;
  return ready as ReadyMessage;
}

function isExactDelegatedRuntime(
  descriptor: Op["runtimeDescriptor"],
): descriptor is ExactDelegatedRuntimeDescriptor {
  return descriptor?.kind === "delegated-op" && descriptor.adapter === "provider-exact";
}

function defaultEntryPath(): string {
  const js = fileURLToPath(new URL("./process-worker-entry.js", import.meta.url));
  if (existsSync(js)) return js;
  return fileURLToPath(new URL("./process-worker-entry.ts", import.meta.url));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
