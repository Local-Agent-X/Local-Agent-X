/**
 * End-of-shift boot proof for an autopilot run.
 *
 * Autopilot validates each round with build + size (+ optional test) but never
 * BOOTS the result, so a summary could honestly say "5 rounds passed" for code
 * that compiles yet won't start. Autopilot commits to its OWN branch and a
 * human runs the `git merge` — so this is NOT a brick vector, but the human
 * deserves a real boot signal before they merge.
 *
 * After the loop ends, if any round committed, we boot the worktree once (bind)
 * and exercise it (smoke), reusing the exact gates the self_edit sandbox uses,
 * and fold the verdict into the run summary.
 */

import { rmSync } from "node:fs";
import { gateBind, gateSmoke, killProbe } from "../self-edit-sandbox-gates.js";
import { pickProbePort } from "../self-edit-sandbox.js";
import { getRuntimeConfig } from "../config.js";
import type { AutopilotConfig, BootProof } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("autopilot.boot-proof");

/** Boot the autopilot worktree on a probe port and run the smoke assertions.
 *  Reuses the self_edit sandbox's bind + smoke gates so there is one definition
 *  of "did this code actually start". Always cleans up the probe + temp data dir. */
export async function runEndOfShiftBootProof(config: AutopilotConfig, signal?: AbortSignal): Promise<BootProof> {
  const start = Date.now();
  const authToken = getRuntimeConfig().authToken;
  const port = pickProbePort();
  logger.info(`[autopilot.boot-proof] booting ${config.worktreeName} on probe port ${port}`);

  const bind = await gateBind(config.worktreeName, port, authToken, signal);
  try {
    if (!bind.result.ok) {
      return { status: "failed", detail: `Server failed to bind: ${bind.result.detail.slice(0, 600)}`, durationMs: Date.now() - start };
    }
    const smoke = await gateSmoke(port, authToken, signal);
    if (!smoke.ok) {
      return { status: "failed", detail: `Smoke check failed: ${smoke.detail.slice(0, 600)}`, durationMs: Date.now() - start };
    }
    return {
      status: "passed",
      detail: "Server bound on probe port and smoke endpoints (chat + health/tools/sessions) responded 200.",
      durationMs: Date.now() - start,
    };
  } finally {
    killProbe(bind.proc);
    if (bind.dataDir) {
      try { rmSync(bind.dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
