import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeParseBody, safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { kokoroVoiceList, tier4Readiness } from "../../../voice/tier4/index.js";
import { IS_WIN, TIERS, tierById } from "./tiers.js";
import { isInstalled, probeHealth, probeVoiceNpmDeps, tierStatus } from "./detection.js";
import { killTier, startTierAndWait } from "./process-control.js";
import { running } from "./state.js";

const logger = createLogger("routes.bridges.voice-setup");

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

      logger.info(`[voice-setup] Installing ${tier.id} via ${tier.installerPath}`);
      const installerCmd = IS_WIN
        ? { command: "powershell", args: ["-ExecutionPolicy", "Bypass", "-File", tier.installerPath] }
        : { command: "bash", args: [tier.installerPath] };
      const proc = spawn(installerCmd.command, installerCmd.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      proc.stdout?.on("data", c => { out += c.toString(); });
      proc.stderr?.on("data", c => { out += c.toString(); });
      const exitCode: number = await new Promise(r => proc.on("exit", code => r(code ?? -1)));
      const ok = exitCode === 0 && isInstalled(tier);
      if (ok) logger.info(`[voice-setup] ${tier.id} installed (exit ${exitCode})`);
      else logger.warn(`[voice-setup] ${tier.id} install failed (exit ${exitCode})`);
      json(ok ? 200 : 500, { ok, exitCode, output: out.slice(-4000) });
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

      // Studio (Chatterbox) and Studio-Trained (SoVITS) are clone WORKERS —
      // they synthesize from reference clips but have no STT, no VAD, and
      // no internal routing. Lite is the API frontdoor that web voice mode
      // talks to over WS, and Lite proxies trained/clone synth requests
      // INTO Studio/SoVITS at synth time. Starting Studio without Lite
      // gives you a worker with nothing to dispatch to it. Auto-start
      // Lite as a hard prereq so the user doesn't have to remember the
      // dependency order. Skipped if Lite isn't installed (no recovery
      // path from here — surface that as a clear error).
      if (tier.id === "studio" || tier.id === "studio-trained") {
        const lite = tierById("lite");
        if (lite && isInstalled(lite)) {
          const lh = await probeHealth(lite.healthUrl);
          if (!lh.ok) {
            const ok = await startTierAndWait(lite);
            if (!ok) {
              json(502, { error: `${tier.label} requires Lite as a dispatcher, but Lite failed to start. Open the Lite card and start it manually to see the error.` });
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

      const ok = await startTierAndWait(tier);
      if (!ok) {
        const proc = running.get(tier.id);
        json(504, { error: `${tier.label} didn't report healthy within 3 min — but pid ${proc?.pid ?? "?"} is still running. Cold-start can be slow; try clicking Start again in 30s, or check logs.` });
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

  if (method === "GET" && url.pathname === "/api/voice/tier4/voices") {
    try {
      json(200, { default: tier4Readiness().defaultVoice, voices: kokoroVoiceList() });
    } catch (e) { json(500, { error: safeErrorMessage(e) }); }
    return true;
  }

  return false;
};
