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
  lostRegistrationAdapterFactory,
  setRenderProbe,
  type CanonicalLane,
  type PreviewRuntimeError,
} from "../canonical-loop/index.js";
import { reconcileCanonicalLearnedOutcomes } from "../canonical-loop/public/learned-protocols.js";
import type { LAXConfig } from "../types.js";
import { createLogger } from "../logger.js";
import { restorePersistedAppBuildRuntimes } from "../tools/build-app-runtime.js";
import { startRecoveryJanitor } from "../canonical-loop/recovery-janitor.js";

const logger = createLogger("server.canonical-loop-bootstrap");

const ALL_LANES: CanonicalLane[] = ["interactive", "build", "ide", "background"];

/**
 * Register the default Anthropic adapter for every lane so submitted ops
 * have a factory to drive the turn loop. Without this the canonical route
 * persists the op as queued and then fails on the next microtask with
 * adapter_not_configured.
 *
 * Also starts recovery sweeps for stale canonical ops on disk: any op left
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

  // The `agent` lane is deliberately NOT in ALL_LANES: an agent-spawn op always
  // registers its own per-op provider adapter (agent-runner/register-adapter.ts),
  // so a generic Anthropic lane default would be wrong for it. But the lane
  // default must still be non-empty, or a recovered agent-lane op with no per-op
  // registration (its registration died with the crashed process) has no factory
  // and queues forever (OP-4). resolveAdapterFactory already fail-closes a
  // running-recovery relaunch via attemptCount>0; this catches the remaining
  // shape — an agent op recovered from `queued` (OP-6 requeue, which consumes no
  // recovery attempt so attemptCount stays 0) — by making the lane default the
  // same fail-closed lost-registration adapter, so it finalizes running->failed
  // with a resubmit reason instead of hanging.
  setDefaultAdapterForLane("agent", lostRegistrationAdapterFactory);
  logger.info(`[canonical-loop] lost-registration fail-closed adapter registered for lane: agent`);

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
  setRenderProbe(async (url, appDescription, opId): Promise<PreviewRuntimeError[] | null> => {
    const { probeApp } = await import("../desktop-bridge.js");
    const result = await probeApp(url, { wantScreenshot: true });
    if (!result) return null;
    const errors: PreviewRuntimeError[] = result.errors.map((e) => ({
      kind: e.kind, message: e.message, source: e.source, line: e.line, ts: Date.now(),
    }));
    if (result.screenshotB64) {
      const { visionVerdictForScreenshot } = await import("../tools/app-tools/vision-verify.js");
      const { getDesignSpec } = await import("../canonical-loop/index.js");
      const verdict = await visionVerdictForScreenshot(result.screenshotB64, appDescription, {}, getDesignSpec(opId));
      if (verdict && !verdict.ok) {
        errors.push({ kind: "blank", message: `Screenshot looks broken: ${verdict.reason}`, ts: Date.now() });
      } else if (verdict && verdict.ok && verdict.design) {
        // App renders fine — stash its design score for the design-verify gate
        // (decide-outcome runs it last, after the app is proven non-broken /
        // compiling / behaving). Only when NOT broken: a broken app retries for
        // brokenness first, and a design nudge over a broken screenshot is noise.
        const { recordDesignVerdict } = await import("../canonical-loop/index.js");
        recordDesignVerdict(opId, verdict.design);
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
      const restored = restorePersistedAppBuildRuntimes();
      const recovered = sweepStaleCanonicalOps();
      const learned = reconcileCanonicalLearnedOutcomes();
      const dt = Date.now() - t;
      if (recovered.length > 0) {
        const summary = recovered
          .map(r => `${r.opId}=${r.outcome.kind}`)
          .join(", ");
        logger.info(`[canonical-loop] background sweep recovered ${recovered.length} stale op(s) and reconciled ${learned.committed.length} learned outcome(s) in ${dt}ms: ${summary}`);
      } else {
        logger.info(`[canonical-loop] background sweep completed in ${dt}ms (restored ${restored.length} app build runtime(s), reconciled ${learned.committed.length} learned outcome(s), no stale ops)`);
      }
    } catch (e) {
      logger.warn(`[canonical-loop] background sweep failed: ${(e as Error).message}`);
    }
  });
  // Keep using the same lease-aware sweep after boot so a worker that dies
  // while this server remains alive cannot strand its op until a restart.
  startRecoveryJanitor();
}
