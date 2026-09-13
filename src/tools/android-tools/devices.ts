/**
 * list_devices / start_emulator / stop_emulator — device + emulator lifecycle.
 */

import type { ToolResult } from "../../types.js";
import { listDevices, listAvds, startEmulator, stopEmulator, resolveSerial } from "../../android/index.js";
import { ok, err } from "../result-helpers.js";

export async function handleListDevices(): Promise<ToolResult> {
  const devices = await listDevices();
  if (devices.length === 0) return ok("No devices connected. Use 'start_emulator' to boot one.");
  const lines = devices.map((d) => `${d.serial}\t${d.state}${d.model ? `\t${d.model}` : ""}`);
  return ok(`Connected devices:\n${lines.join("\n")}`);
}

const DEFAULT_AVD_NAME = "lax_default";

export async function handleStartEmulator(args: Record<string, unknown>): Promise<ToolResult> {
  const avdName = args.avd_name ? String(args.avd_name) : DEFAULT_AVD_NAME;
  const avds = await listAvds().catch(() => [] as string[]);
  if (avds.length > 0 && !avds.includes(avdName)) {
    return err(`AVD "${avdName}" not found. Available AVDs: ${avds.join(", ") || "(none)"}.`);
  }
  try {
    const { serial } = await startEmulator(avdName);
    return ok(`Emulator "${avdName}" is booted and ready (device ${serial}).`);
  } catch (e) {
    return err(`Failed to start emulator "${avdName}": ${(e as Error).message}`);
  }
}

export async function handleStopEmulator(args: Record<string, unknown>): Promise<ToolResult> {
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  await stopEmulator(serial);
  return ok(`Emulator ${serial} stopped.`);
}
