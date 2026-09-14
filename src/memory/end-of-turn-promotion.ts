/**
 * Promotion capability for the end-of-turn writer — split out of
 * end-of-turn-write.ts (the 400-LOC source-hygiene ceiling).
 *
 * Every memory write must carry a capability whose claims the gate (write-
 * safely.ts → assertMemoryPromotionAllowed) recomputes and verifies. Tool
 * calls get theirs stamped by the approval phase; this out-of-band pass
 * mints its own.
 */
import { hasExternalIngestion } from "../data-lineage/external.js";
import {
  promotionContextFromToolArgs,
  rowsContainUntrustedMarker,
  stampCleanModelPromotion,
  type MemoryPromotionContext,
  type MemoryPromotionRequest,
} from "./promotion-gate.js";
import type { EndOfTurnContext, WriteDecisionPayload } from "./end-of-turn-write.js";

/** Audit-trail source of this writer's claims. The clean-session mint appends
 *  CLEAN_SELF_SOURCE_SUFFIX, so a landed write is recorded as
 *  "end-of-turn-classifier:clean-self" — auto-allowed, NOT human-approved. */
export const PROMOTION_SOURCE = "end-of-turn-classifier";
/** Claim target: the profile routing key memory_update_profile's sink stamps
 *  for USER.md (memory/tools/save.ts), so these claims twin the model's own
 *  profile write — same content (the new text), target, origin and tier. */
const PROMOTION_TARGET = "memory:profile:user";
/** Inference tier — what the approval phase assigns a model profile write
 *  that declares no provenance (factMetadata in promotion-gate.ts). The
 *  classifier's verdict is a model inference about the user, never a
 *  verbatim user statement. */
const PROMOTION_PROVENANCE = "inference";
const PROMOTION_CONFIDENCE = 0.6;

/**
 * Why an unattended end-of-turn write may NOT promote on this turn, or null
 * when it may. Mirrors the approval phase's precondition for a silent model
 * self-save (require-approval.ts): the session never ingested off-box content
 * (data-lineage/external.ts, decision D6) AND the turn carries no
 * external-untrusted marker. Where the tool path falls through to an
 * interactive approval card, this background pass has nobody to ask — and a
 * profile file cannot carry per-item provenance the way the Facts DB can —
 * so the honest answer is to decline (the caller logs it as a taint-gate
 * block).
 */
export function unattendedPromotionBlocker(ctx: EndOfTurnContext): string | null {
  if (hasExternalIngestion(ctx.sessionId)) {
    return "session ingested external content — profile auto-promotion needs approval (D6)";
  }
  // Persist could not recover the turn's rows (readOpMessages fallback): the
  // tool results are unknown, so the turn is not provably clean.
  if (ctx.turnMessages === null) {
    return "turn rows unavailable (persist fallback) — not provably clean, profile auto-promotion declined";
  }
  // Scan EVERY row of the turn — tool results included, no last-user-row
  // anchor (a mid-turn inject row would shift cleanTurnForModelSelfSave's
  // window past a marked tool result). Non-ingesting tools emit markers too
  // (sql_* wrappers, read_file's INJECTION WARNING) and D6 excludes them.
  if (rowsContainUntrustedMarker(ctx.turnMessages)) {
    return "turn carries an external-untrusted marker — profile auto-promotion needs approval";
  }
  return null;
}

/**
 * Mint this write's capability through the SAME clean-session model-self-save
 * mint the approval phase uses (stampCleanModelPromotion), once
 * unattendedPromotionBlocker has established its precondition.
 * Not createInternalMemoryContext: that claims durable_memory origin at
 * confidence 1 — the mint for trusted-code rewrites of memory that already
 * passed the gate (compression, consolidation, sync). The classifier's verdict
 * is fresh assistant-origin inference; claiming otherwise would launder it past
 * the taint policy the tool path applies to identical content. The claims are
 * exactly what the gate recomputes: content (= evidenceContent), target,
 * source, session, provenance, confidence, origin.
 *
 * `overrides` lets a caller mint the same clean-session claim for a DIFFERENT
 * sink — e.g. the daily-log overflow fallback, which writes the classifier's
 * content to "memory:daily-log" instead of the profile when the profile is
 * at capacity.
 */
export function mintCleanSelfPromotion(
  d: WriteDecisionPayload,
  sessionId: string,
  overrides?: { target?: string; source?: string; content?: string },
): MemoryPromotionContext {
  const request: MemoryPromotionRequest = {
    content: overrides?.content ?? d.content,
    target: overrides?.target ?? PROMOTION_TARGET,
    source: overrides?.source ?? PROMOTION_SOURCE,
    sessionId,
    provenance: PROMOTION_PROVENANCE,
    confidence: PROMOTION_CONFIDENCE,
    origin: "assistant",
  };
  // The stamp rides a tool-args carrier (the approval→sink hand-off object in
  // the dispatch pipeline). Mint and sink are one function here, so the
  // carrier is local and never leaves this scope.
  const carrier: Record<string, unknown> = {};
  stampCleanModelPromotion(carrier, request);
  return promotionContextFromToolArgs(carrier, request);
}
