import type { Op } from "../../ops/types.js";
import { getToolsForOp } from "../runtime.js";
import { getEvidenceHistory } from "../middlewares/evidence-history.js";
import {
  buildCanonicalLoopContext,
  getActiveMiddlewareStack,
  type BuildContextArgs,
} from "../middlewares/host.js";

type ContextOverrides = Omit<BuildContextArgs, "op" | "turnIdx" | "tools" | "evidenceHistory">;

export function createTurnContextComposer(op: Op, turnIdx: number) {
  const evidenceHistory = getEvidenceHistory(op.id);
  const middlewareStack = getActiveMiddlewareStack();

  return {
    middlewareStack,
    build(overrides: ContextOverrides = {}) {
      return buildCanonicalLoopContext({
        op,
        turnIdx,
        tools: getToolsForOp(op.id),
        evidenceHistory,
        ...overrides,
      });
    },
  };
}
