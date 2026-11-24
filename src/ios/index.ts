/**
 * iOS device control: the iPhone counterpart to src/android. A target is an
 * iOS Simulator (macOS only) or an iPhone on USB. What this machine can do
 * with each is Apple's call, not ours, so it is stated, not discovered by
 * failing:
 *
 *   on a Mac:     Simulator: boot, install, launch, URL, screenshot, log,
 *                 tap / swipe / type / keys (idb). iPhone: list, screenshot,
 *                 installed apps, install and launch (devicectl).
 *   on Windows:   iPhone only: list, screenshot, installed apps. No
 *                 Simulator, no tapping, no installing: Apple's tools for
 *                 those run on macOS only.
 */
import { listSimulators, type Simulator } from "./simctl.js";
import { listUsbIphones, type UsbIphone } from "./usb-device.js";

export * from "./simctl.js";
export * from "./usb-device.js";
export { simulatorTap, simulatorSwipe, simulatorType, simulatorKey, IOS_KEYS } from "./idb.js";
export { runIosTool } from "./run.js";

export const IS_MAC = process.platform === "darwin";

export type IosTarget =
  | { kind: "simulator"; udid: string; name: string; os: string; booted: boolean }
  | { kind: "iphone"; udid: string; name: string; os: string; model: string };

/** What needs a Mac, in one sentence the tools repeat. */
export const NEEDS_A_MAC =
  "This needs a Mac: the iOS Simulator and Apple's tools for driving, installing and launching apps run on macOS only. " +
  "On this machine LAX can list a USB-connected iPhone, take its screenshot, list its apps and read a log captured from it.";

const fromSim = (s: Simulator): IosTarget => ({ kind: "simulator", udid: s.udid, name: s.name, os: s.os, booted: s.state === "Booted" });
const fromIphone = (d: UsbIphone): IosTarget => ({ kind: "iphone", udid: d.udid, name: d.name, os: d.os, model: d.model });

/** Every target this machine can see: Simulators (Mac only) and USB iPhones.
 *  A tool that is not installed contributes nothing, and is named in `missing`. */
export async function listIosTargets(): Promise<{ targets: IosTarget[]; missing: string[] }> {
  const targets: IosTarget[] = [];
  const missing: string[] = [];
  if (IS_MAC) {
    try { targets.push(...(await listSimulators()).map(fromSim)); } catch (e) { missing.push((e as Error).message); }
  }
  try { targets.push(...(await listUsbIphones()).map(fromIphone)); } catch (e) { missing.push((e as Error).message); }
  return { targets, missing };
}

/** The named target, or the one in use: a single USB iPhone, else a single
 *  booted Simulator. */
export async function resolveIosTarget(udid?: string): Promise<IosTarget> {
  const { targets, missing } = await listIosTargets();
  if (udid) {
    const t = targets.find((x) => x.udid === udid || x.name === udid);
    if (!t) throw new Error(`No iOS device or simulator "${udid}".${missing.length ? ` ${missing.join(" ")}` : ""}`);
    return t;
  }
  const live = targets.filter((t) => t.kind === "iphone" || t.booted);
  if (live.length === 1) return live[0];
  if (live.length === 0) {
    throw new Error(`No iPhone on USB${IS_MAC ? " and no booted Simulator (use boot_simulator)" : ""}.${missing.length ? ` ${missing.join(" ")}` : ""}`);
  }
  throw new Error(`More than one iOS target (${live.map((t) => `${t.name} ${t.udid}`).join(", ")}): pass 'device'.`);
}
