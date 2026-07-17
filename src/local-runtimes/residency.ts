/**
 * Model residency + background warm-up for the local Ollama-native runtime.
 *
 * Why: the first /api/generate after idle pays the model cold-load INSIDE the
 * caller's timeout — 16.5s observed on this box (2026-07) against classifier
 * wallclocks of 3s. The caller burns its whole budget on a load whose result
 * it never sees, and may pay it again next turn. The honest primitives:
 *
 *   isModelResident() — ask the runtime what is actually loaded (/api/ps) so
 *     short-budget callers can skip a call that cannot succeed in time.
 *   warmModel()       — fire-and-forget load with keep_alive so the NEXT
 *     call runs hot.
 *
 * Deliberately config-blind: callers pass the baseUrl they would have
 * dispatched to. Consumers: the classifier cold-skip (classify-with-llm.ts);
 * chat-side pre-warm rides the same helpers.
 */
import { createLogger } from "../logger.js";

const logger = createLogger("local-runtimes");

const PS_TIMEOUT_MS = 2_000;
// Generous on purpose: the warm request's entire job is to sit through the
// cold load (16.5s observed; bigger models slower). Aborting mid-load risks
// cancelling the very load we asked for, and the promise is detached — a
// pending warm costs the caller nothing. This cap only bounds a hung socket.
const WARM_TIMEOUT_MS = 60_000;

/** How long the runtime holds a model in memory after a call. One knob,
 *  shared with callOllama's keep_alive, so warmed and real calls extend the
 *  same residency window instead of drifting. */
export const MODEL_KEEP_ALIVE = "30m";

/** Ollama aliases an untagged name to ":latest" ("llama3" and "llama3:latest"
 *  are the same model). Only that default-tag alias is normalized — real tag
 *  variants stay distinct: "llama3.2:3b" vs "llama3.2:3b-instruct" are
 *  different models and must never cross-match. */
function withDefaultTag(id: string): string {
  return id.includes(":") ? id : `${id}:latest`;
}

/**
 * Is `model` loaded in memory on the runtime at `baseUrl`?
 *   true  — /api/ps lists it.
 *   false — /api/ps answered and it is not there. (Note: /api/ps cannot
 *           distinguish "installed but cold" from "not installed at all".)
 *   null  — cannot tell (unreachable, timeout, non-OK, malformed). Callers
 *           MUST treat null as "proceed as before", never as cold. Never
 *           throws.
 * `timeoutMs` bounds the probe (default 2s). Callers running under a tight
 * wallclock pass a slice of their own budget so a hung /api/ps socket can
 * never cost more than the call it was trying to save.
 */
export async function isModelResident(
  baseUrl: string,
  model: string,
  timeoutMs: number = PS_TIMEOUT_MS,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/ps`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const models = data && typeof data === "object" ? (data as { models?: unknown }).models : null;
    if (!Array.isArray(models)) return null;
    const wanted = withDefaultTag(model);
    return models.some((m) => {
      if (!m || typeof m !== "object") return false;
      const row = m as { name?: unknown; model?: unknown };
      return (typeof row.name === "string" && withDefaultTag(row.name) === wanted)
        || (typeof row.model === "string" && withDefaultTag(row.model) === wanted);
    });
  } catch (e) {
    logger.debug(`residency probe failed (${baseUrl}): ${(e as Error).message}`);
    return null;
  }
}

// One in-flight warm per (baseUrl, model). Every cold turn re-fires warmModel
// while the first load is still running; stacked /api/generate calls for the
// same model would just queue inside the runtime for no gain. Entries clear
// on settle so a model that idles out later can be warmed again.
const inflightWarms = new Map<string, Promise<void>>();

/**
 * Fire-and-forget: load `model` and hold it for MODEL_KEEP_ALIVE. Empty
 * prompt + stream:false is the documented warm-up shape — the runtime loads
 * the model and returns without generating. Never throws, never blocks the
 * caller. A warm is advisory — its failure is debug-noise, not a hidden
 * outage: the next REAL call still surfaces any genuine failure loudly.
 */
export function warmModel(baseUrl: string, model: string): void {
  const base = baseUrl.replace(/\/+$/, "");
  const key = `${base}|${model}`;
  if (inflightWarms.has(key)) return;
  const run = (async () => {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: MODEL_KEEP_ALIVE }),
        signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      });
      logger.debug(res.ok
        ? `warm completed (model=${model})`
        : `warm failed: HTTP ${res.status} (model=${model})`);
    } catch (e) {
      logger.debug(`warm failed (model=${model}): ${(e as Error).message}`);
    } finally {
      inflightWarms.delete(key);
    }
  })();
  inflightWarms.set(key, run);
}
