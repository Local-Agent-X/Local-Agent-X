/**
 * What device_check reads off a device: which one it is, whether the app is
 * installed, and its log, on either platform (device-check-tool.ts decides
 * what the log shows, device-check.ts how).
 *
 * Android keeps a log buffer to read back (`logcat -d`); so does an iOS
 * Simulator (`log show`). A real iPhone does not keep one a tool can read
 * afterwards: its log is a live stream, so it is captured to a file while the
 * flow runs (`pymobiledevice3 syslog live`, in the background) and the file
 * is handed in as `log_file`. A file works for any device.
 */
import { readFileSync } from "node:fs";
import { deviceInfo, dumpLog, listApps, resolveSerial } from "../android/index.js";
import { resolveIosTarget, simulatorHasApp, simulatorLog, usbIphoneApps } from "../ios/index.js";

export interface DeviceReading {
  device: { serial: string; model: string; os: string };
  installed: boolean;
  log: string;
}

export type DevicePlatform = "android" | "ios";

/** How to capture a real iPhone's log, for the agent. */
export const IPHONE_LOG_CAPTURE =
  "A real iPhone keeps no log a tool can read back. Before running the flow, start `pymobiledevice3 syslog live > <file>` " +
  "with process_start, run the flow (or have the owner run it), stop the capture, then run device_check with `log_file` set to that file.";

export async function readAndroidDevice(packageName: string, device?: string, logFile?: string): Promise<DeviceReading> {
  const serial = await resolveSerial(device);
  const info = await deviceInfo(serial);
  const apps = await listApps(serial, false);
  return {
    device: { serial, model: info.model, os: `Android ${info.android}` },
    installed: apps.some((a) => a.packageName === packageName),
    log: logFile ? readFileSync(logFile, "utf8") : await dumpLog(serial),
  };
}

export async function readIosDevice(bundleId: string, device?: string, logFile?: string): Promise<DeviceReading> {
  const t = await resolveIosTarget(device);
  if (t.kind === "simulator") {
    return {
      device: { serial: t.udid, model: `${t.name} Simulator`, os: t.os },
      installed: await simulatorHasApp(t.udid, bundleId),
      log: logFile ? readFileSync(logFile, "utf8") : await simulatorLog(t.udid, 30),
    };
  }
  if (!logFile) throw new Error(IPHONE_LOG_CAPTURE);
  return {
    device: { serial: t.udid, model: `${t.name} (${t.model})`, os: t.os },
    installed: (await usbIphoneApps(t.udid)).includes(bundleId),
    log: readFileSync(logFile, "utf8"),
  };
}
