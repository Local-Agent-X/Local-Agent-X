import {
  certificationFingerprint,
  certificationSelectionFingerprint,
} from "./certification-fingerprint.js";
import { LOCAL_MODEL_CERTIFICATION_SCENARIOS } from "./certification-scenarios.js";
import { LocalCertificationStore } from "./certification-store.js";
import { localCertificationTransport } from "./certification-transport.js";
import { LOCAL_MODEL_CERTIFICATION_CONTRACT } from "./certification-types.js";
import type {
  CertificationFailure,
  CertificationContract,
  CertificationIdentity,
  CertificationScenarioId,
  CertificationScenarioResult,
  CertificationTransport,
  LocalModelCertification,
} from "./certification-types.js";
import { probeFor } from "./probes.js";
import type { LocalModel, LocalRuntimeInfo } from "./types.js";

const CALL_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 150_000;
const MAX_CALLS = 5;
const TRANSIENT_FAILURES = new Set<CertificationFailure>([
  "aborted",
  "auth_rejected",
  "runtime_unavailable",
  "server_error",
  "timeout",
  "transport_error",
]);

class CertificationDeadlineError extends Error {}
class CertificationAbortedError extends Error {}

function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (parentSignal.aborted) return Promise.reject(new CertificationAbortedError());
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      controller.abort();
      finish(() => reject(new CertificationAbortedError()));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new CertificationDeadlineError()));
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    parentSignal.addEventListener("abort", onAbort, { once: true });
    if (parentSignal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (settled) throw new CertificationAbortedError();
        return work(controller.signal);
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

export interface CertificationRunnerDeps {
  transport?: CertificationTransport;
  store?: Pick<LocalCertificationStore, "read" | "write">;
  now?: () => number;
  resolveIdentity?: (
    runtime: LocalRuntimeInfo,
    model: string,
    signal: AbortSignal,
  ) => Promise<CertificationIdentity>;
}

export interface CertificationRestoreDeps {
  store?: Pick<LocalCertificationStore, "read">;
  resolveIdentity?: CertificationRunnerDeps["resolveIdentity"];
}

export interface CertificationRunInput {
  runtime: LocalRuntimeInfo;
  model: string;
  signal?: AbortSignal;
}

let queue: Promise<void> = Promise.resolve();
interface PublishedCertification {
  certificationHash: string;
  selectionHash: string;
}
const publishedCertifications = new WeakMap<
  LocalRuntimeInfo,
  WeakMap<LocalModel, PublishedCertification>
>();

function unpublishCertification(input: CertificationRunInput): void {
  const model = input.runtime.models.find((candidate) => candidate.id === input.model);
  if (model) publishedCertifications.get(input.runtime)?.delete(model);
}

function passedCertification(result: LocalModelCertification): boolean {
  return result.fingerprint.reusable
    && result.passedCount === LOCAL_MODEL_CERTIFICATION_SCENARIOS.length
    && LOCAL_MODEL_CERTIFICATION_CONTRACT.scenarios.every((id) => result.scenarios[id]?.passed);
}

function publishCertification(input: CertificationRunInput, result: LocalModelCertification): void {
  if (!passedCertification(result)) return;
  const model = input.runtime.models.find((candidate) => candidate.id === input.model);
  if (!model) return;
  let published = publishedCertifications.get(input.runtime);
  if (!published) {
    published = new WeakMap<LocalModel, PublishedCertification>();
    publishedCertifications.set(input.runtime, published);
  }
  published.set(model, {
    certificationHash: result.fingerprint.hash,
    selectionHash: certificationSelectionFingerprint(input.runtime, input.model, result.fingerprint.hash),
  });
}

function canCarryPublishedSelection(
  previousRuntime: LocalRuntimeInfo,
  previousModel: LocalModel,
  runtime: LocalRuntimeInfo,
  model: LocalModel,
): boolean {
  const published = publishedCertifications.get(previousRuntime)?.get(previousModel);
  if (!published) return false;
  return published.selectionHash === certificationSelectionFingerprint(
    previousRuntime,
    previousModel.id,
    published.certificationHash,
  ) && published.selectionHash === certificationSelectionFingerprint(
    runtime,
    model.id,
    published.certificationHash,
  );
}

/**
 * A process-local proof that this exact discovery snapshot passed the current
 * certification contract. It deliberately cannot revive persisted evidence:
 * choosing a background model must never probe a runtime on its hot path.
 */
export function hasPublishedCertification(runtime: LocalRuntimeInfo, model: LocalModel, contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT): boolean {
  return publishedCertificationSelectionHash(runtime, model, contract) !== null;
}
export function publishedCertificationSelectionHash(runtime: LocalRuntimeInfo, model: LocalModel, contract: CertificationContract = LOCAL_MODEL_CERTIFICATION_CONTRACT): string | null {
  const published = publishedCertifications.get(runtime)?.get(model);
  if (!published) return null;
  const current = certificationSelectionFingerprint(
    runtime,
    model.id,
    published.certificationHash,
    contract,
  );
  return current === published.selectionHash ? current : null;
}

async function defaultIdentity(
  runtime: LocalRuntimeInfo,
  model: string,
  signal: AbortSignal,
): Promise<CertificationIdentity> {
  const method = probeFor(runtime.kind)?.certificationIdentity;
  if (!method) return { runtimeVersion: null, modelDigest: null };
  try {
    return await method(runtime.endpoint, model, signal);
  } catch {
    return { runtimeVersion: null, modelDigest: null };
  }
}

/**
 * Restore only persisted proof for the exact live runtime/model identity.
 * This path never owns a scenario transport and therefore cannot certify on a
 * miss; it either publishes a complete current-contract hit or does nothing.
 */
export async function restorePublishedCertification(
  input: CertificationRunInput,
  deps: CertificationRestoreDeps = {},
): Promise<boolean> {
  const parentSignal = input.signal ?? new AbortController().signal;
  if (parentSignal.aborted || !input.runtime.models.some((model) => model.id === input.model)) {
    return false;
  }
  let identity: CertificationIdentity;
  try {
    identity = await withDeadline(
      (signal) => (deps.resolveIdentity ?? defaultIdentity)(input.runtime, input.model, signal),
      parentSignal,
      CALL_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
  const fingerprint = certificationFingerprint(input.runtime, input.model, identity);
  if (!fingerprint.reusable || parentSignal.aborted) return false;
  let cached: LocalModelCertification | null;
  try {
    cached = (deps.store ?? new LocalCertificationStore()).read(fingerprint.hash);
  } catch {
    return false;
  }
  if (!cached || cached.fingerprint.hash !== fingerprint.hash || !passedCertification(cached)) {
    return false;
  }
  publishCertification(input, cached);
  const model = input.runtime.models.find((candidate) => candidate.id === input.model)!;
  return hasPublishedCertification(input.runtime, model);
}

/**
 * Rehydrate a new discovery snapshot in the background. On restart every
 * model is checked for an exact persisted hit. On refresh, only selections
 * that were published on the preceding snapshot are eligible to carry.
 */
export async function restorePublishedCertifications(
  runtimes: readonly LocalRuntimeInfo[],
  previousRuntimes: readonly LocalRuntimeInfo[] | null = null,
  deps: CertificationRestoreDeps = {},
): Promise<number> {
  let restored = 0;
  for (const runtime of runtimes) {
    for (const model of runtime.models) {
      if (previousRuntimes && !previousRuntimes.some((previousRuntime) => (
        previousRuntime.models.some((previousModel) => (
          previousModel.id === model.id
          && canCarryPublishedSelection(previousRuntime, previousModel, runtime, model)
        ))
      ))) continue;
      if (await restorePublishedCertification({ runtime, model: model.id }, deps)) restored += 1;
    }
  }
  return restored;
}

function hasContextFailureSignal(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && [
    "context_length_exceeded",
    "context_window_exceeded",
    "max_context_length",
    "prompt_too_long",
  ].includes(code);
}

function failureFor(id: CertificationScenarioId, status: number, body: unknown): CertificationFailure {
  if (status === 401 || status === 403) return "auth_rejected";
  if (status >= 500) return "server_error";
  if (status === 408 || status === 425 || status === 429) return "transport_error";
  if (id === "context_degradation" && (status === 413 || hasContextFailureSignal(body))) {
    return "context_rejected";
  }
  return "bad_response";
}

function verificationFailure(id: CertificationScenarioId): CertificationFailure {
  if (id === "strict_json_schema") return "invalid_json";
  if (id === "required_tool_call") return "missing_tool_call";
  return "missing_marker";
}

function emptyResult(failure: CertificationFailure): CertificationScenarioResult {
  return { passed: false, calls: 0, latencyMs: 0, failure };
}

async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function certifyLocalModel(
  input: CertificationRunInput,
  deps: CertificationRunnerDeps = {},
): Promise<LocalModelCertification> {
  return runExclusive(async () => {
    unpublishCertification(input);
    const now = deps.now ?? Date.now;
    const transport = deps.transport ?? localCertificationTransport;
    const store = deps.store ?? new LocalCertificationStore();
    const startedAt = now();
    const parentSignal = input.signal ?? new AbortController().signal;
    let identity: CertificationIdentity = { runtimeVersion: null, modelDigest: null };
    if (!parentSignal.aborted) {
      try {
        identity = await withDeadline(
          (signal) => (deps.resolveIdentity ?? defaultIdentity)(input.runtime, input.model, signal),
          parentSignal,
          Math.min(CALL_TIMEOUT_MS, RUN_TIMEOUT_MS),
        );
      } catch {
        identity = { runtimeVersion: null, modelDigest: null };
      }
    }
    const fingerprint = certificationFingerprint(input.runtime, input.model, identity);
    const cached = fingerprint.reusable && !parentSignal.aborted ? store.read(fingerprint.hash) : null;
    if (cached) {
      publishCertification(input, cached);
      return cached;
    }

    const scenarios = {} as LocalModelCertification["scenarios"];
    let callCount = 0;
    let stopFailure: CertificationFailure | null = null;
    for (const scenario of LOCAL_MODEL_CERTIFICATION_SCENARIOS) {
      if (stopFailure) {
        scenarios[scenario.id] = emptyResult(stopFailure);
        continue;
      }
      if (callCount >= MAX_CALLS || now() - startedAt >= RUN_TIMEOUT_MS) {
        scenarios[scenario.id] = emptyResult("timeout");
        continue;
      }
      if (parentSignal.aborted) {
        scenarios[scenario.id] = emptyResult("aborted");
        continue;
      }
      const callStartedAt = now();
      const remaining = Math.max(1, RUN_TIMEOUT_MS - (callStartedAt - startedAt));
      callCount += 1;
      try {
        const response = await withDeadline((signal) => transport({
            endpoint: input.runtime.endpoint,
            kind: input.runtime.kind,
            model: input.model,
            body: scenario.body(input.model),
            signal,
          }), parentSignal, Math.min(CALL_TIMEOUT_MS, remaining));
        const latencyMs = Math.max(0, Math.round(now() - callStartedAt));
        if (response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") {
          const failure = failureFor(scenario.id, response.status, response.body);
          scenarios[scenario.id] = {
            passed: false, calls: 1, latencyMs, failure,
          };
          if (TRANSIENT_FAILURES.has(failure)) stopFailure = failure;
        } else {
          const passed = scenario.verify(response.body);
          scenarios[scenario.id] = {
            passed, calls: 1, latencyMs, failure: passed ? null : verificationFailure(scenario.id),
          };
        }
      } catch (error) {
        const latencyMs = Math.max(0, Math.round(now() - callStartedAt));
        const aborted = parentSignal.aborted || error instanceof CertificationAbortedError;
        const timedOut = error instanceof CertificationDeadlineError || now() - startedAt >= RUN_TIMEOUT_MS;
        const failure = aborted ? "aborted" : timedOut ? "timeout" : "runtime_unavailable";
        scenarios[scenario.id] = {
          passed: false,
          calls: 1,
          latencyMs,
          failure,
        };
        stopFailure = failure;
      }
    }
    const values = Object.values(scenarios);
    const result: LocalModelCertification = {
      version: 1,
      fingerprint,
      scenarios,
      passedCount: values.filter((value) => value.passed).length,
      callCount,
      totalLatencyMs: values.reduce((sum, value) => sum + value.latencyMs, 0),
    };
    if (!values.some((value) => value.failure && TRANSIENT_FAILURES.has(value.failure))) {
      store.write(result);
    }
    publishCertification(input, result);
    return result;
  });
}
