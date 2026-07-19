import type {
  QualificationDriver,
  QualificationScorecard,
  QualificationStage,
  QualificationStageName,
} from "./types.js";

const CERTIFICATION_SCENARIO_IDS = [
  "baseline_marker",
  "strict_json_schema",
  "required_tool_call",
  "tool_result_continuation",
  "context_degradation",
] as const;

export interface QualificationRunOptions {
  signal?: AbortSignal;
  stageTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export function readQualificationConfig(env: NodeJS.ProcessEnv): { endpoint: string; model: string } {
  const endpoint = env.LAX_REAL_LOCAL_ENDPOINT?.trim() ?? "";
  const model = env.LAX_REAL_LOCAL_MODEL_TAG?.trim() ?? "";
  if (env.LAX_REAL_LOCAL_MODEL !== "1" || !endpoint || !model) {
    throw new Error("LAX_REAL_LOCAL_MODEL=1, LAX_REAL_LOCAL_ENDPOINT, and LAX_REAL_LOCAL_MODEL_TAG are required");
  }
  const parsed = new URL(endpoint);
  const host = parsed.hostname.toLowerCase();
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host)) {
    throw new Error("local qualification endpoint must be loopback http(s)");
  }
  return { endpoint, model };
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class QualificationTimeoutError extends Error {}
class QualificationAbortError extends Error {}

function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new QualificationAbortError()));
    const timer = setTimeout(
      () => finish(() => reject(new QualificationTimeoutError())),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function runQualification(
  driver: QualificationDriver,
  options: QualificationRunOptions = {},
): Promise<QualificationScorecard> {
  const stages: QualificationStage[] = [];
  let digest: string | null = null;
  let cleanupOk = false;
  const stageTimeoutMs = options.stageTimeoutMs ?? 6 * 60_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 15_000;

  const stage = async <T>(name: QualificationStageName, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await bounded(Promise.resolve().then(run), stageTimeoutMs, options.signal);
      stages.push({ name, ok: true, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      stages.push({
        name,
        ok: false,
        durationMs: Date.now() - started,
        failure: error instanceof QualificationTimeoutError
          ? "timeout"
          : error instanceof QualificationAbortError ? "aborted" : "failed",
      });
      throw error;
    }
  };

  try {
    await stage("isolated_boot", () => driver.start());

    const initial = await stage("passive_pre_certification", async () => {
      const status = await driver.status();
      requireCondition(status.found, "configured Ollama model was not discovered");
      requireCondition(!status.verified, "model was behaviorally certified before operator POST");
      requireCondition(status.certificationCalls === 0, "automatic certification traffic occurred before operator POST");
      digest = status.digest;
      return status;
    });

    await stage("operator_certification", async () => {
      const result = await driver.certify(initial.runtimeId);
      requireCondition(result.operatorGuarded, "certification POST was not operator guarded");
      requireCondition(result.ok, "operator certification failed");
      requireCondition(result.passedCount === 5 && result.scenarioCount === 5, "operator certification was not exactly 5/5");
      requireCondition(result.callCount === 5, "operator certification did not use exactly five scenario calls");
      requireCondition(
        result.scenarioIds.length === CERTIFICATION_SCENARIO_IDS.length
          && CERTIFICATION_SCENARIO_IDS.every((id, index) => result.scenarioIds[index] === id),
        "operator certification scenario ids did not match the fixed contract",
      );
    });

    await stage("status_reads", async () => {
      const first = await driver.status();
      const second = await driver.status();
      requireCondition(first.verified && second.verified, "certification status did not remain verified");
      requireCondition(first.certificationCalls === 5 && second.certificationCalls === 5, "status GET triggered certification traffic");
    });

    await stage("chat_sse", async () => {
      const result = await driver.chat("baseline");
      requireCondition(result.done && result.hasText && result.errorEvents === 0, "real chat SSE did not complete cleanly with text");
    });

    await stage("workspace_read", async () => {
      const result = await driver.chat("workspace-read");
      requireCondition(result.done, "workspace-read turn did not complete");
      requireCondition(result.errorEvents === 0, "workspace-read turn emitted an error");
      requireCondition(result.safeReadLifecycle, "workspace read did not emit a matching allowed tool lifecycle");
      requireCondition(result.forbiddenControlEvents === 0, "safe workspace read emitted a control request");
      requireCondition(result.readNonceSeen, "workspace read did not continue with nonce evidence");
      await driver.chat("history");
      await driver.chat("history");
      await driver.chat("history");
    });

    await stage("compaction", async () => {
      const result = await driver.compact();
      requireCondition(result.ok, "manual compaction failed");
      requireCondition(result.backgroundRequests === 1, "compaction did not issue exactly one background request");
      requireCondition(result.persistedMessageCount >= 10, "fewer than ten messages were persisted before compaction");
      requireCondition(
        result.persistedSummary && result.summaryIsLeading && result.summaryContainsMarker,
        "generated compacted context was not persisted as the leading summary with the synthetic marker",
      );
    });

    await stage("restart_restore", async () => {
      await driver.restart();
      const status = await driver.status();
      requireCondition(status.verified, "exact certification did not restore after restart");
      requireCondition(status.certificationCalls === 5, "restart restore reran behavioral scenarios");
      const compacted = await driver.persistedSummary();
      requireCondition(compacted.persisted && compacted.containsMarker, "persisted compacted context did not survive restart");
    });

    await stage("continuity", async () => {
      const result = await driver.chat("continuity");
      requireCondition(result.done && result.continuityMarkerSeen, "final chat did not continue from compacted context");
    });
  } catch {
    // The failing stage already owns the sanitized diagnostic.
  } finally {
    try {
      await bounded(Promise.resolve().then(() => driver.cleanup()), cleanupTimeoutMs);
      cleanupOk = true;
    } catch {
      cleanupOk = false;
    }
  }

  return {
    version: 1,
    ok: stages.length === 9 && stages.every((item) => item.ok) && cleanupOk,
    runtime: "ollama",
    model: { tag: driver.model, digest },
    stages,
    cleanup: { ok: cleanupOk },
  };
}
