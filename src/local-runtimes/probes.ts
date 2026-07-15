/**
 * Probe registry — the only file that imports every runtime adapter.
 * Order matters for the auto-discovery sweep: when two probes claim the
 * same port (they don't today), the first detect() win takes it.
 */
import type { LocalRuntimeKind, LocalRuntimeProbe } from "./types.js";
import { ollamaProbe } from "./ollama-probe.js";

export const LOCAL_RUNTIME_PROBES: readonly LocalRuntimeProbe[] = [ollamaProbe];

export function probeFor(kind: LocalRuntimeKind): LocalRuntimeProbe | null {
  return LOCAL_RUNTIME_PROBES.find((p) => p.kind === kind) ?? null;
}
