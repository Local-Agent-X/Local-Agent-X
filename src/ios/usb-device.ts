/**
 * A real iPhone over USB. Listing, screenshots and the installed-app list go
 * through pymobiledevice3, which runs on Windows and macOS alike (Apple's own
 * tools are macOS-only). Installing and launching a build needs a signed app
 * and Apple's `xcrun devicectl`, so those are macOS-only.
 *
 * A screenshot on iOS 17+ needs the developer disk image mounted, which
 * pymobiledevice3 does with `mounter auto-mount`; its own error says so.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIosText } from "./run.js";

export interface UsbIphone {
  udid: string;
  name: string;
  /** e.g. "iPhone16,2". */
  model: string;
  os: string;
}

/** `pymobiledevice3 usbmux list`: a JSON array of connected devices. */
export function parseUsbmuxList(json: string): UsbIphone[] {
  const rows = JSON.parse(json) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => (r.ConnectionType ?? "USB") === "USB")
    .map((r) => ({
      udid: String(r.UniqueDeviceID ?? r.Identifier ?? ""),
      name: String(r.DeviceName ?? "iPhone"),
      model: String(r.ProductType ?? ""),
      os: `iOS ${String(r.ProductVersion ?? "?")}`,
    }))
    .filter((d) => d.udid);
}

const pmd = (args: string[], timeoutMs?: number) => runIosText("pymobiledevice3", args, timeoutMs);

export async function listUsbIphones(): Promise<UsbIphone[]> {
  return parseUsbmuxList(await pmd(["usbmux", "list"]));
}

export async function usbIphoneScreenshot(udid: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "lax-iphone-shot-"));
  try {
    const file = join(dir, "screen.png");
    await pmd(["developer", "dvt", "screenshot", file, "--udid", udid], 60_000);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bundle ids of the apps installed on the device. */
export async function usbIphoneApps(udid: string): Promise<string[]> {
  return Object.keys(JSON.parse(await pmd(["apps", "list", "--udid", udid], 60_000)) as Record<string, unknown>);
}

/** Install a signed .app or .ipa (macOS: `xcrun devicectl`). */
export async function installOnIphone(udid: string, appPath: string): Promise<void> {
  await runIosText("xcrun", ["devicectl", "device", "install", "app", "--device", udid, appPath], 180_000);
}

export async function launchOnIphone(udid: string, bundleId: string): Promise<void> {
  await runIosText("xcrun", ["devicectl", "device", "process", "launch", "--device", udid, bundleId], 60_000);
}
