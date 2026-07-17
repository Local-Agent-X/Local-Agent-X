import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { kokoroVoiceList, tier4Readiness } from "../../../voice/tier4/index.js";
import { TIERS, tierById } from "./tiers.js";
import { isInstalled, probeHealth, probeVoiceNpmDeps, tierStatus } from "./detection.js";
import { killTier, sidecarLogPath, startTierAndWait, type StartOutcome } from "./process-control.js";
import { runInstaller } from "./install-runner.js";
import { runVoiceDoctor } from "./doctor.js";
import { running } from "./state.js";

const logger = createLogger("routes.bridges.voice-setup");

/**
 * Describe a failed start in terms of what actually happened. A crashed
 * sidecar and a slow one need opposite advice — "wait 30s and retry" is
 * useless when the process is already dead — so report the real cause and
 * quote the log tail rather than asserting a timeout that may not have
 * occurred.
 */
export function startFailureSummary(tierId: string, outcome: Extract<StartOutcome, { ok: false }>): string {
  const tail = outcome.logTail ? `\n\nLast log lines:\n${outcome.logTail}` : "";
  if (outcome.reason === "exited") {
    return `crashed on startup (exit code ${outcome.exitCode ?? "unknown"}). Retrying won't help until the cause is fixed. Full log: ${sidecarLogPath(tierId)}${tail}`;
  }
  return `didn't report healthy within 3 min, but pid ${outcome.pid ?? "?"} is still running. Cold-start can be slow; try Start again in 30s.${tail}`;
}

export const handleVoiceSetupRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "GET" && url.pathname === "/api/voices/setup/status") {
    const tiers = await Promise.all(TIERS.map(tierStatus));
    json(200, { platform: platform(), tiers, npm: probeVoiceNpmDeps() });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/install") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native is provisioned via npm install — no install/start/stop needed." }); return true;
      }
      if (!tier.installerPath || !existsSync(tier.installerPath)) {
        json(400, { error: `No installer for ${tier.label}. See docs.` }); return true;
      }

      const r = await runInstaller(tier);
      json(r.ok ? 200 : 500, r);
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  // Repair = stop → re-run installer → start. For users whose tier is
  // "installed" but broken at runtime (stale CUDA wheels, AV-corrupted
  // packages): the installers are idempotent with a verify pass, and the
  // stop first releases the DLLs pip needs to replace — an in-place pip
  // upgrade under a running sidecar fails on locked files.
  if (method === "POST" && url.pathname === "/api/voices/setup/repair") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native is provisioned via npm install — run npm install to repair." }); return true;
      }
      if (!tier.installerPath || !existsSync(tier.installerPath)) {
        json(400, { error: `No installer for ${tier.label}.` }); return true;
      }

      const wasRunning = !!running.get(tier.id) || (await probeHealth(tier.healthUrl)).ok;
      logger.info(`[voice-setup] repairing ${tier.id} (wasRunning=${wasRunning})`);
      killTier(tier.id);
      const r = await runInstaller(tier);
      if (!r.ok) { json(500, { ...r, restarted: false }); return true; }
      let restarted = false;
      if (wasRunning) {
        const outcome = await startTierAndWait(tier);
        restarted = outcome.ok;
        if (!outcome.ok) {
          json(502, { ...r, restarted, error: `Repaired, but ${tier.label} ${startFailureSummary(tier.id, outcome)}` });
          return true;
        }
      }
      json(200, { ...r, restarted });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/start") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native runs in-process — no sidecar to start." }); return true;
      }
      if (!isInstalled(tier)) { json(400, { error: `${tier.label} is not installed yet.` }); return true; }

      // Studio-Vox (VoxCPM) and Studio (Chatterbox) are clone WORKERS —
      // they synthesize from reference clips but have no STT, no VAD, and
      // no internal routing. Lite is the API frontdoor that web voice mode
      // talks to over WS, and Lite proxies clone synth requests INTO them
      // at synth time. Starting a worker without Lite gives you a worker
      // with nothing to dispatch to it. Auto-start Lite as a hard prereq
      // so the user doesn't have to remember the dependency order. Skipped
      // if Lite isn't installed (no recovery path from here — surface that
      // as a clear error).
      if (tier.id === "studio" || tier.id === "studio-vox") {
        const lite = tierById("lite");
        if (lite && isInstalled(lite)) {
          const lh = await probeHealth(lite.healthUrl);
          if (!lh.ok) {
            const outcome = await startTierAndWait(lite);
            if (!outcome.ok) {
              json(502, {
                error: `${tier.label} requires Lite as a dispatcher, but Lite ${startFailureSummary(lite.id, outcome)}`,
                reason: outcome.reason,
                logTail: outcome.logTail,
              });
              return true;
            }
            logger.info(`[voice-setup] auto-started Lite as prereq for ${tier.id}`);
          }
        } else if (lite && !isInstalled(lite)) {
          json(400, { error: `${tier.label} requires Lite as a dispatcher. Lite isn't installed yet — install it first.` });
          return true;
        }
      }

      // Already up?
      const existingHealth = await probeHealth(tier.healthUrl);
      if (existingHealth.ok) { json(200, { ok: true, already: true, healthPayload: existingHealth.payload }); return true; }

      const outcome = await startTierAndWait(tier);
      if (!outcome.ok) {
        json(outcome.reason === "exited" ? 502 : 504, {
          error: `${tier.label} ${startFailureSummary(tier.id, outcome)}`,
          reason: outcome.reason,
          logTail: outcome.logTail,
        });
        return true;
      }
      const proc = running.get(tier.id);
      json(200, { ok: true, pid: proc?.pid });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/voices/setup/stop") {
    try {
      const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
      const tierId = String((body as { tier?: string }).tier || "");
      const tier = tierById(tierId);
      if (!tier) { json(400, { error: `Unknown tier: ${tierId}` }); return true; }
      if (tier.kind === "native") {
        json(400, { error: "Tier 4 native runs in-process — nothing to stop." }); return true;
      }
      killTier(tier.id);
      json(200, { ok: true });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  // One-click end-to-end checkup: health of every voice sidecar + a real
  // mic-path round-trip (synthesized speech streamed back through the same
  // WS the browser uses). POST because it exercises the GPU.
  if (method === "POST" && url.pathname === "/api/voices/doctor") {
    try {
      json(200, await runVoiceDoctor());
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/voice/tier4/voices") {
    try {
      json(200, { default: tier4Readiness().defaultVoice, voices: kokoroVoiceList() });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
