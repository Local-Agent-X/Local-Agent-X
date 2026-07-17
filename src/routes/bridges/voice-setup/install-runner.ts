import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createLogger } from "../../../logger.js";
import { IS_WIN, type VoiceTier } from "./tiers.js";
import { isInstalled } from "./detection.js";

const logger = createLogger("routes.bridges.voice-setup");

export interface InstallOutcome {
  ok: boolean;
  exitCode: number;
  output: string;
}

/**
 * Run a tier's installer script to completion. Shared by the install route
 * and the repair route — repair is the same operation run over an existing
 * (possibly broken) venv, which the installers support: they are idempotent
 * and end with a verify-imports pass that fails loudly.
 */
export async function runInstaller(tier: VoiceTier): Promise<InstallOutcome> {
  if (!tier.installerPath || !existsSync(tier.installerPath)) {
    return { ok: false, exitCode: -1, output: `No installer for ${tier.label}.` };
  }
  logger.info(`[voice-setup] running installer for ${tier.id}: ${tier.installerPath}`);
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
  if (ok) logger.info(`[voice-setup] ${tier.id} installer succeeded (exit ${exitCode})`);
  else logger.warn(`[voice-setup] ${tier.id} installer failed (exit ${exitCode})`);
  return { ok, exitCode, output: out.slice(-4000) };
}
