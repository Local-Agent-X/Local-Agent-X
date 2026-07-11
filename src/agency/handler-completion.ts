import { propagateTaint } from "../data-lineage/index.js";
import { propagateExternalIngestion } from "../data-lineage/external.js";
import { createLogger } from "../logger.js";
import type { FieldAgent } from "./handler-types.js";

const logger = createLogger("agency.handler-completion");

/** Push a completion notice onto the parent session's queue so the parent's
 * agent loop sees it on the next iteration without needing to poll. */
export function pushCompletionToParent(
  agent: FieldAgent,
  status: "succeeded" | "failed",
  result: string,
): void {
  const parent = agent.parentSessionId;
  if (!parent) return;
  // Taint propagation (parent ← child): if the sub-agent read sensitive data
  // during its run, that taint must follow its result back to the parent so
  // the parent's egress + kernel gates see it. The child's tool calls record
  // taint under `req.sessionId ?? agent-<id>` (server/handler-events.ts:
  // runSessionId) — for operations-executor phases that's a borrowed id like
  // `agent-op-<opId>`, NOT `agent-<id>`. We stored that exact bucket as
  // runSessionId at spawn time, so propagate FROM it; falling back to
  // `agent-<id>` for the default (auto-minted-session) case. Using the
  // re-derived `agent-<id>` unconditionally orphaned the taint whenever a
  // borrowed session was set (finding H4). Best-effort: a propagation failure
  // must never block the completion notice. (Note: run-sandboxed already
  // redacts raw tool results before the child model sees them — this is the
  // egress-taint floor, defense in depth, not the sole barrier.)
  try {
    const childSession = agent.runSessionId ?? `agent-${agent.id}`;
    const moved = propagateTaint(childSession, parent);
    if (moved > 0) {
      logger.info(`[handler] propagated ${moved} taint label(s) from sub-agent ${agent.id} → parent session ${parent}`);
    }
    // Same seam, other trust axis: if the child ingested off-box content
    // (web/browser/MCP), its result carries that content into the parent's
    // context — the parent's memory auto-promotion gate must see the mark too
    // (data-lineage/external.ts, D6).
    if (propagateExternalIngestion(childSession, parent)) {
      logger.info(`[handler] propagated external-ingestion mark from sub-agent ${agent.id} → parent session ${parent}`);
    }
  } catch (e) {
    logger.error(`[handler] taint propagation failed for sub-agent ${agent.id} → parent ${parent}: ${(e as Error).message}`);
  }
  // Loud-log if completion-queue plumbing fails. Previously the empty
  // catches swallowed import errors and enqueue errors — symptom was
  // the parent's session never learning the sub-agent finished, and
  // the AGENTS sidebar card stuck "running" until manual cleanup. With
  // logging the failure becomes greppable in server.log.
  try {
    import("./completion-queue.js").then(({ enqueueCompletion }) => {
      try {
        enqueueCompletion(parent, {
          agentId: agent.id,
          agentName: agent.name,
          status,
          result: typeof result === "string" ? result : String(result),
          timestamp: Date.now(),
        });
      } catch (e) {
        logger.error(`[handler] enqueueCompletion failed for sub-agent ${agent.id} → parent ${parent}: ${(e as Error).message}`);
      }
    }).catch((e: Error) => {
      logger.error(`[handler] completion-queue import failed for sub-agent ${agent.id} → parent ${parent}: ${e.message}`);
    });
  } catch (e) {
    logger.error(`[handler] pushCompletionToParent threw for sub-agent ${agent.id} → parent ${parent}: ${(e as Error).message}`);
  }
}
