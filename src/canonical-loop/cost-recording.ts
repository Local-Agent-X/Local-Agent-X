/**
 * Live cost-ledger writer for canonical-loop ops.
 *
 * Always-on observer on the canonical event seam (`emit`). When an op
 * terminates (`state_changed` → succeeded|failed|cancelled), it aggregates
 * the op's real per-turn token usage and writes one row into the
 * user-facing cost ledger (cost-tracker's `trackUsage`), which backs
 * getTodayCost / getSessionCost / getUsageSummary.
 *
 * This is the production writer that makes those readers non-empty — soak
 * (soak-metrics.ts) only emits an estimate into its own JSONL canary and is
 * gated behind CANONICAL_LOOP_SOAK + skipped under test; this writer is
 * decoupled from the soak flag and runs unconditionally.
 *
 * Pure instrumentation — never throws, never blocks the op terminal path.
 * Ops with no token payload (`sawAnyUsage` false / `model` null) — e.g. the
 * FakeAdapter used in tests — are naturally skipped, so no test gate is
 * needed.
 */
import { aggregateOpUsage } from "./op-usage.js";
import { readOp } from "../ops/op-store.js";
import { trackUsage } from "../cost-tracker.js";
import type { CanonicalEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.cost-recording");

let warnedOnce = false;

export function recordCostEvent(event: CanonicalEvent): void {
	try {
		if (event.type !== "state_changed") return;
		const body = (event.body ?? {}) as Record<string, unknown>;
		const to = body.to as string | undefined;
		if (to !== "succeeded" && to !== "failed" && to !== "cancelled") return;

		const opId = event.opId;
		const usage = aggregateOpUsage(opId);
		// No real token payload (e.g. FakeAdapter ops) → nothing to bill.
		if (!usage.sawAnyUsage || !usage.model) return;

		const op = readOp(opId);
		const sessionId = op?.canonical?.sessionId ?? null;
		const provider = op?.contextPack?.routing?.preferredProvider ?? null;
		const authSource = op?.contextPack?.routing?.authSource;

		trackUsage(
			sessionId ?? "unknown",
			usage.model,
			provider ?? "unknown",
			usage.usageInputTokens,
			usage.usageOutputTokens,
			undefined,
			authSource,
		);
	} catch (e) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(`[cost] event hook failed (further suppressed): ${(e as Error).message}`);
		}
	}
}

/** Test-only: reset the warn-once latch. */
export function _resetCostRecordingForTests(): void {
	warnedOnce = false;
}
