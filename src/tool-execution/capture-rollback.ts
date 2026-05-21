// Rollback-capture phase: fires only when the autonomy profile decides
// "allow-with-rollback" for this tool call. Snapshot what we can before
// the tool runs; never block on capture failure (a missing backup is
// worse than nothing, but a thrown exception here would block a tool the
// profile already approved).

import { getToolDecision } from "../approval-manager.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import { captureRollback } from "../autonomy/rollback.js";
import { createLogger } from "../logger.js";
import type { Phase } from "./context.js";

const logger = createLogger("tool-execution");

export const captureRollbackPhase: Phase = async (ctx) => {
  if (getToolDecision(ctx.tc.name) !== "allow-with-rollback") return;
  try {
    const contract = captureRollback(
      ctx.tc.id,
      ctx.tc.name,
      classifyToolRisk(ctx.tc.name),
      ctx.args,
    );
    const useful = contract.artifacts.filter((a) => a.type !== "none").length;
    if (useful > 0) {
      logger.info(`[rollback] captured ${useful} artifact(s) for ${ctx.tc.name} (toolCallId=${ctx.tc.id})`);
    }
  } catch (e) {
    logger.warn(`[rollback] capture threw for ${ctx.tc.name}: ${(e as Error).message}`);
  }
};
