/**
 * Emulator process lifecycle — list AVDs, boot one, tear it down. Boot state
 * is tracked in-memory only (per server process); a restart forgets running
 * emulators the same way process-tools forgets shelled-out children.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { emulatorBin } from "./sdk-paths.js";
import { runAdbText } from "./adb-run.js";
import { listDevices } from "./adb.js";
import { createLogger } from "../logger.js";

const log = createLogger("android.emulator");

interface RunningEmulator {
  proc: ChildProcess;
  serial: string | null; // filled in once adb sees it
}

const running = new Map<string, RunningEmulator>(); // avdName -> handle

export function listAvds(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(emulatorBin(), ["-list-avds"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`spawn emulator failed: ${(e as Error).message}. Is the Android SDK installed?`));
      return;
    }
    let out = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    proc.on("error", (e) => reject(new Error(`emulator spawn error: ${e.message}`)));
    proc.on("close", () => resolve(out.split("\n").map((l) => l.trim()).filter(Boolean)));
  });
}

/** Poll `adb devices` for an emulator-* serial that boots after `startedAt`,
 *  then wait for sys.boot_completed. Bounded so a wedged emulator errors
 *  instead of hanging the tool call forever. */
async function waitForBoot(avdName: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let serial: string | null = null;
  while (Date.now() < deadline) {
    if (!serial) {
      const devices = await listDevices().catch(() => []);
      const candidate = devices.find((d) => d.serial.startsWith("emulator-"));
      if (candidate) serial = candidate.serial;
    }
    if (serial) {
      const booted = await runAdbText(["-s", serial, "shell", "getprop", "sys.boot_completed"], 5_000).catch(() => "");
      if (booted.trim() === "1") return serial;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Emulator "${avdName}" did not finish booting within ${Math.round(timeoutMs / 1000)}s.`);
}

export async function startEmulator(avdName: string, bootTimeoutMs = 90_000): Promise<{ serial: string }> {
  if (running.has(avdName)) {
    const existing = running.get(avdName)!;
    if (existing.serial) return { serial: existing.serial };
  }
  let proc;
  try {
    // -no-snapshot-load: a stale saved-state snapshot is a common source of
    // "boots but adb never sees sys.boot_completed" hangs on a fresh install.
    proc = spawn(emulatorBin(), ["-avd", avdName, "-no-snapshot-load"], { stdio: "ignore", detached: true });
    proc.unref();
  } catch (e) {
    throw new Error(`spawn emulator failed: ${(e as Error).message}. Is the Android SDK installed?`);
  }
  const handle: RunningEmulator = { proc, serial: null };
  running.set(avdName, handle);
  proc.on("exit", () => running.delete(avdName));
  try {
    const serial = await waitForBoot(avdName, bootTimeoutMs);
    handle.serial = serial;
    return { serial };
  } catch (e) {
    log.warn(`emulator "${avdName}" failed to boot: ${(e as Error).message}`);
    try { proc.kill(); } catch { /* already gone */ }
    running.delete(avdName);
    throw e;
  }
}

export async function stopEmulator(serial: string): Promise<void> {
  await runAdbText(["-s", serial, "emu", "kill"]);
  for (const [avdName, handle] of running) {
    if (handle.serial === serial) running.delete(avdName);
  }
}

export function runningEmulators(): Array<{ avdName: string; serial: string | null }> {
  return [...running.entries()].map(([avdName, handle]) => ({ avdName, serial: handle.serial }));
}
