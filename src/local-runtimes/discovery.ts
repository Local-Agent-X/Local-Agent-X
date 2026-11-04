/**
 * Discovery orchestration: candidate endpoints → detect → list → probe,
 * with bounded concurrency. Produces LocalRuntimeInfo[] for the cache.
 *
 * Sweep shape: every candidate is tried against every probe (or only its
 * named kind for manual adds); first probe whose detect() answers claims
 * the endpoint. Per-model deep probes run after listing so a runtime
 * with many models doesn't serialize the whole sweep.
 */
import { endpointHostPort } from "./admission.js";
import { LOCAL_RUNTIME_PROBES } from "./probes.js";
import type { CandidateEndpoint } from "./endpoints.js";
import type { LocalModel, LocalRuntimeInfo, LocalRuntimeProbe } from "./types.js";

/** Cap concurrent per-model probes so a 50-model runtime doesn't stampede. */
const MODEL_PROBE_CONCURRENCY = 4;

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// The probes' own deadlines (ollama-probe.ts, openai-compat-probe.ts): detect
// 1.5 s, list 3-4 s. The sweep sets them itself so it can tell a runtime that
// is not there from one it got no answer from: a refused loopback connection
// fails in microseconds and an Ollama that is up answers /api/version in
// milliseconds, so a "no" with the deadline spent means the sweep never got an
// answer. At every boot the event loop is too busy for one in time, and the
// first sweep found no Ollama in 4.3 s without ever reaching it (2026-11-03).
const DETECT_DEADLINE_MS = 1_500;
const LIST_DEADLINE_MS = 4_000;

/** The deadline a probe call runs under (a seam: tests hand in their own). */
export type Deadline = (ms: number) => AbortSignal;
const realDeadline: Deadline = (ms) => AbortSignal.timeout(ms);

/** An endpoint the sweep could not judge: its probe got no answer in time. */
const INCONCLUSIVE = Symbol("inconclusive");

async function claimProbe(c: CandidateEndpoint, deadline: Deadline): Promise<LocalRuntimeProbe | null | typeof INCONCLUSIVE> {
  const candidates = c.kind
    ? LOCAL_RUNTIME_PROBES.filter((p) => p.kind === c.kind)
    : LOCAL_RUNTIME_PROBES;
  let unanswered = false;
  for (const probe of candidates) {
    const signal = deadline(DETECT_DEADLINE_MS);
    if (await probe.detect(c.endpoint, signal)) return probe;
    unanswered ||= signal.aborted;
  }
  return unanswered ? INCONCLUSIVE : null;
}

async function surveyEndpoint(c: CandidateEndpoint, deadline: Deadline): Promise<LocalRuntimeInfo | null | typeof INCONCLUSIVE> {
  const probe = await claimProbe(c, deadline);
  if (!probe || probe === INCONCLUSIVE) return probe;
  // The runtime REGISTRY is chat-facing (picker, per-model routing, context
  // windows), so embedding-only models are filtered here — the ONE place
  // that owns that rule. Probes report them marked (never dropped) because
  // the embedding-settings picker and boot-time embedding warmer read the
  // probes directly via fetchLocalOllamaTags and need to see embedders.
  const listSignal = deadline(LIST_DEADLINE_MS);
  const all = await probe.listModels(c.endpoint, listSignal);
  if (all.length === 0 && listSignal.aborted) return INCONCLUSIVE;
  const listed = all.filter((m) => !m.embeddingOnly);
  const models: LocalModel[] = await mapBounded(listed, MODEL_PROBE_CONCURRENCY, async (m) => ({
    ...m,
    ...(await probe.probeModel(c.endpoint, m.id)),
  }));
  const hostPort = endpointHostPort(c.endpoint.baseUrl) ?? c.endpoint.baseUrl;
  const identified = c.label ?? (probe.identify ? await probe.identify(c.endpoint) : null);
  return {
    kind: probe.kind,
    id: `${probe.kind}@${hostPort}`,
    label: identified ?? probe.label,
    endpoint: c.endpoint,
    chatBaseUrl: `${c.endpoint.baseUrl.replace(/\/+$/, "")}/v1`,
    models,
    refreshedAt: Date.now(),
  };
}

export interface LocalRuntimeSweep {
  runtimes: LocalRuntimeInfo[];
  /** Base URLs of endpoints the sweep got no answer from in time: not
   *  evidence of absence, so the cache keeps what it knew of them and asks
   *  again soon. */
  inconclusive: string[];
}

/** Sweep all candidates concurrently. Unreachable endpoints just drop out. */
export async function discoverLocalRuntimes(
  candidates: readonly CandidateEndpoint[],
): Promise<LocalRuntimeSweep> {
  // Test-env guard: the sweep is the ONE place this subsystem does live
  // loopback network I/O. Under vitest that's both a CI-hygiene problem (real
  // fetches during the suite) and a determinism hazard — a dev running tests
  // with Ollama/LM Studio up would discover real models and diverge from CI.
  // Every caller already tolerates an empty result, so bail before the wire.
  // The probe adapters keep their coverage: their tests call detect()/
  // listModels() directly rather than through this sweep.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return { runtimes: [], inconclusive: [] };
  return sweepCandidates(candidates, realDeadline);
}

/** The sweep itself, without the test-env guard (discovery.test.ts drives it). */
export async function sweepCandidates(candidates: readonly CandidateEndpoint[], deadline: Deadline): Promise<LocalRuntimeSweep> {
  const surveyed = await Promise.all(candidates.map((c) => surveyEndpoint(c, deadline)));
  return {
    runtimes: surveyed.filter((r): r is LocalRuntimeInfo => r !== null && r !== INCONCLUSIVE),
    inconclusive: candidates.filter((_, i) => surveyed[i] === INCONCLUSIVE).map((c) => c.endpoint.baseUrl),
  };
}
