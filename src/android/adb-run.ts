/**
 * Canonical adb invocation — timeout, SIGKILL-on-hang, stdout/stderr capture
 * written once. Mirrors runFfmpeg (ffmpeg-run.ts); every adb.ts call goes
 * through here instead of spawning ad hoc.
 */

import { spawn } from "node:child_process";
import { adbBin } from "./sdk-paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("android.adb");

export interface AdbRunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export function runAdb(args: string[], timeoutMs = 15_000): Promise<AdbRunResult> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(adbBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`spawn adb failed: ${(e as Error).message}`));
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`adb ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`adb spawn error: ${e.message}. Is the Android SDK installed?`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, code });
    });
  });
}

/** Text-output convenience wrapper for the common (non-binary) case. */
export async function runAdbText(args: string[], timeoutMs?: number): Promise<string> {
  const result = await runAdb(args, timeoutMs);
  if (result.code !== 0) {
    log.warn(`adb ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
    throw new Error(result.stderr.trim() || `adb ${args.join(" ")} exited with code ${result.code}`);
  }
  return result.stdout.toString("utf8");
}
