/**
 * Production canary bootstrap for the canonical-loop.
 *
 * Lives in its own module (rather than inline in lifecycle.ts) so the test
 * suite can import it without dragging the full server transitive graph
 * (ari-kernel and friends) through the vitest resolver.
 */
import {
  setDefaultAdapterForLane,
  createAnthropicAdapter,
  sweepStaleCanonicalOps,
  setLaneCapConfigReader,
} from "../canonical-loop/index.js";
import type { CanonicalLane } from "../canonical-loop/types.js";
import { setRenderProbe } from "../canonical-loop/turn-loop/render-verify.js";
import type { PreviewRuntimeError } from "../canonical-loop/turn-loop/render-verify.js";
import type { LAXConfig } from "../types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.canonical-loop-bootstrap");

const ALL_LANES: CanonicalLane[] = ["interactive", "build", "ide", "background"];

/**
 * Register the default Anthropic adapter for every lane so submitted ops
 * have a factory to drive the turn loop. Without this the canonical route
 * persists the op as queued and then fails on the next microtask with
 * adapter_not_configured.
 *
 * Also runs a one-shot sweep of stale canonical ops on disk: any op left
 * in `running` / `cancelling` with an expired lease (typically because
 * the prior server got SIGTERM mid-op) is routed through the
 * canonical-loop's `recoverStaleOp` primitive so it transitions to a
 * clean terminal/queued state instead of sitting orphaned forever.
 */
export function bootstrapCanonicalLoop(configReader?: () => LAXConfig): void {
  for (const lane of ALL_LANES) {
    setDefaultAdapterForLane(lane, () => createAnthropicAdapter());
  }
  logger.info(`[canonical-loop] AnthropicAdapter registered for lanes: ${ALL_LANES.join(", ")}`);

  // Wire the live runtime-config reader so config-driven lane caps
  // (maxInteractiveSessions) take effect and follow hot-reload. Passing the
  // reader in keeps this module free of config.ts's import-time side effects.
  if (configReader) setLaneCapConfigReader(configReader);

  // Wire the headless render probe: when a "done" build touched app files but no
  // open preview reported errors, the render-verify gate loads the app in a
  // hidden window and — if it captured a screenshot — asks the screenshot judge
  // whether it looks broken. probeApp returns null on a headless server (no
  // desktop bridge), so the gate degrades to its no-probe behavior. probeApp and
  // the judge are imported lazily so this bootstrap module keeps its light static
  // graph (the test suite imports it without the provider/dispatch transitive set).
  setRenderProbe(async (url, appDescription): Promise<PreviewRuntimeError[] | null> => {
    const { probeApp } = await import("../desktop-bridge.js");
    const result = await probeApp(url, { wantScreenshot: true });
    if (!result) return null;
    const errors: PreviewRuntimeError[] = result.errors.map((e) => ({
      kind: e.kind, message: e.message, source: e.source, line: e.line, ts: Date.now(),
    }));
    if (result.screenshotB64) {
      const { visionVerdictForScreenshot } = await import("../tools/app-tools/vision-verify.js");
      const verdict = await visionVerdictForScreenshot(result.screenshotB64, appDescription);
      if (verdict && !verdict.ok) {
        errors.push({ kind: "blank", message: `Screenshot looks broken: ${verdict.reason}`, ts: Date.now() });
      }
    }
    return errors;
  });

  // Stale-op recovery sweep is a fire-and-forget — no caller waits for the
  // result. Used to run synchronously inside this function and added 9-18s
  // to boot (it scans every op directory on disk and re-reads JSON). Now
  // backgrounded so server.listen() isn't gated by recovery work. New ops
  // submitted during the sweep window are unaffected — they go through
  // submitCanonicalOp which doesn't touch lease-expired rows.
  setImmediate(() => {
    const t = Date.now();
    try {
      const recovered = sweepStaleCanonicalOps();
      const dt = Date.now() - t;
      if (recovered.length > 0) {
        const summary = recovered
          .map(r => `${r.opId}=${r.outcome.kind}`)
          .join(", ");
        logger.info(`[canonical-loop] background sweep recovered ${recovered.length} stale op(s) in ${dt}ms: ${summary}`);
      } else {
        logger.info(`[canonical-loop] background sweep completed in ${dt}ms (no stale ops)`);
      }
    } catch (e) {
      logger.warn(`[canonical-loop] background sweep failed: ${(e as Error).message}`);
    }
  });
}
