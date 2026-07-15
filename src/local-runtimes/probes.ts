/**
 * Probe registry — the only file that imports every runtime adapter.
 * Order matters for the auto-discovery sweep: when two probes claim the
 * same port (they don't today), the first detect() win takes it.
 */
import type { LocalRuntimeKind, LocalRuntimeProbe } from "./types.js";
import { ollamaProbe } from "./ollama-probe.js";
import { openaiCompatProbe } from "./openai-compat-probe.js";

/** Ollama MUST precede openai-compat: Ollama also serves /v1/models, so
 *  the generic probe would claim port 11434 if it detected first. */
export const LOCAL_RUNTIME_PROBES: readonly LocalRuntimeProbe[] = [
  ollamaProbe,
  openaiCompatProbe,
];

export function probeFor(kind: LocalRuntimeKind): LocalRuntimeProbe | null {
  return LOCAL_RUNTIME_PROBES.find((p) => p.kind === kind) ?? null;
}
