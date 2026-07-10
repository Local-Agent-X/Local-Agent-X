/**
 * Probe-on-first-use for Ollama models.
 *
 * The capability registry self-heals from runtime failures — but that means a
 * tool-less local model (qwen2:7b's silent-fail) is only discovered AFTER the
 * first turn empties out. Ollama already knows the answer up front: `/api/show`
 * reports a `capabilities` array (Ollama 0.4+). Asking it once, before the
 * first turn, records the no-tool fact in the registry so day one is correct
 * instead of costing a stumble.
 *
 * Records only the NEGATIVE fact (model lacks "tools"), and only from a clear,
 * non-empty capability list — a malformed or absent response is a no-op, so the
 * probe can never poison a tool-capable model. Never throws; an unreachable
 * Ollama just falls back to the existing runtime self-heal.
 *
 * Ollama-only: `/api/show` is the Ollama native API, served at the root (the
 * registry/adapter use the OpenAI-compat `<root>/v1` URL — we strip the /v1).
 */

import { recordNoTools, hasNoTools } from "./model-capabilities-store.js";
import { createLogger } from "../logger.js";
import { isLocalOnlyMode, isLoopbackUrl } from "../local-only-policy.js";

const logger = createLogger("providers.ollama-probe");

/**
 * One probe per (baseURL, model) per process. The probe is cheap (a localhost
 * round-trip) and idempotent; an in-memory guard avoids re-probing every turn
 * without growing the persisted registry schema with a "probed" timestamp.
 */
const probed = new Set<string>();

interface OllamaShowResponse {
  capabilities?: unknown;
}

function probeKey(baseURL: string, model: string): string {
  return `${baseURL}::${model}`;
}

/** Ollama native API root from the OpenAI-compat baseURL (strip a trailing /v1). */
function ollamaRoot(compatBaseURL: string): string {
  return compatBaseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function probeOllamaCapabilities(
  compatBaseURL: string,
  model: string,
  apiKey?: string,
): Promise<void> {
  if (isLocalOnlyMode() && !isLoopbackUrl(compatBaseURL)) return;
  const key = probeKey(compatBaseURL, model);
  if (probed.has(key)) return;
  probed.add(key);

  // Already known (seed, or a prior learned/latched finding) — nothing to add.
  if (hasNoTools(compatBaseURL, model)) return;

  try {
    const r = await fetch(`${ollamaRoot(compatBaseURL)}/api/show`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        // Local Ollama uses the literal "ollama" placeholder key (no auth);
        // cloud Ollama needs the real bearer token.
        ...(apiKey && apiKey !== "ollama" ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      // `model` is the current field; `name` is the long-standing alias —
      // send both so older and newer Ollama both answer.
      body: JSON.stringify({ model, name: model }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return;
    const caps = ((await r.json()) as OllamaShowResponse).capabilities;
    // Only act on a clear, non-empty list. Absent/empty → can't tell (older
    // Ollama) → leave it to runtime self-heal rather than guess.
    if (!Array.isArray(caps) || caps.length === 0) return;
    if (!caps.includes("tools")) {
      recordNoTools(compatBaseURL, model);
      logger.info(`probe: ${model} declares no tool support — recorded up front`);
    }
  } catch {
    // Unreachable Ollama / timeout / bad JSON — a no-op; the existing runtime
    // self-heal still catches a tool rejection on first real use.
  }
}
