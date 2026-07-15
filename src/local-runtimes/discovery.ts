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

async function claimProbe(c: CandidateEndpoint): Promise<LocalRuntimeProbe | null> {
  const candidates = c.kind
    ? LOCAL_RUNTIME_PROBES.filter((p) => p.kind === c.kind)
    : LOCAL_RUNTIME_PROBES;
  for (const probe of candidates) {
    if (await probe.detect(c.endpoint)) return probe;
  }
  return null;
}

async function surveyEndpoint(c: CandidateEndpoint): Promise<LocalRuntimeInfo | null> {
  const probe = await claimProbe(c);
  if (!probe) return null;
  const listed = await probe.listModels(c.endpoint);
  const models: LocalModel[] = await mapBounded(listed, MODEL_PROBE_CONCURRENCY, async (m) => ({
    ...m,
    ...(await probe.probeModel(c.endpoint, m.id)),
  }));
  const hostPort = endpointHostPort(c.endpoint.baseUrl) ?? c.endpoint.baseUrl;
  return {
    kind: probe.kind,
    id: `${probe.kind}@${hostPort}`,
    label: c.label ?? probe.label,
    endpoint: c.endpoint,
    chatBaseUrl: `${c.endpoint.baseUrl.replace(/\/+$/, "")}/v1`,
    models,
    refreshedAt: Date.now(),
  };
}

/** Sweep all candidates concurrently. Unreachable endpoints just drop out. */
export async function discoverLocalRuntimes(
  candidates: readonly CandidateEndpoint[],
): Promise<LocalRuntimeInfo[]> {
  const surveyed = await Promise.all(candidates.map((c) => surveyEndpoint(c)));
  return surveyed.filter((r): r is LocalRuntimeInfo => r !== null);
}
