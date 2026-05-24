// Per-turn snapshot trigger. Detects which apps this turn touched
// (write/edit only — bash is too noisy) and writes a snapshot of just
// those files into ~/.lax/app-snapshots/<appId>/<turnIdx>-<ts>/. The
// IDE topbar's ↺ Revert dropdown reads them via /api/apps/<id>/snapshots.

import type { ToolCall } from "../contract-types.js";
import {
  extractAppTouchesFromToolCalls,
  snapshotAppTurn,
} from "../../app-tools/snapshots.js";
import { getRuntimeConfig } from "../../config.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("turn-loop.snapshots");

export async function snapshotTouchedApps(
  toolCalls: ToolCall[],
  turnIdx: number,
): Promise<void> {
  try {
    const touches = extractAppTouchesFromToolCalls(toolCalls);
    if (touches.size === 0) return;
    const workspace = getRuntimeConfig().workspace;
    for (const [appId, paths] of touches) {
      try {
        snapshotAppTurn(appId, workspace, turnIdx, paths);
      } catch (e) {
        // Snapshot failure must never break the turn — log and continue.
        logger.warn(`[snapshot] ${appId} turn ${turnIdx}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.warn(`[snapshot] driver error: ${(e as Error).message}`);
  }
}
