/**
 * Taps, swipes, text and keys on an iOS Simulator through Facebook's idb
 * (macOS only: it drives the Simulator through Apple's private frameworks).
 * Chosen over Maestro because it takes the same per-action calls the android
 * tool does (tap at x,y; type into the focused field), so one way of working
 * covers both platforms. Coordinates are the Simulator's points.
 */
import { runIosText } from "./run.js";

const idb = (udid: string, args: string[]) => runIosText("idb", ["ui", ...args, "--udid", udid]);

export async function simulatorTap(udid: string, x: number, y: number): Promise<void> {
  await idb(udid, ["tap", String(Math.round(x)), String(Math.round(y))]);
}

export async function simulatorSwipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
  await idb(udid, ["swipe", ...[x1, y1, x2, y2].map((n) => String(Math.round(n))), "--duration", String(durationMs / 1000)]);
}

export async function simulatorType(udid: string, text: string): Promise<void> {
  await idb(udid, ["text", text]);
}

/** Hardware buttons by name; keys by their USB HID usage code. */
const BUTTONS: Record<string, string> = { home: "HOME", lock: "LOCK", siri: "SIRI" };
const HID_KEYS: Record<string, string> = { enter: "40", delete: "42", tab: "43", escape: "41" };
export const IOS_KEYS = [...Object.keys(BUTTONS), ...Object.keys(HID_KEYS)];

export async function simulatorKey(udid: string, key: string): Promise<void> {
  if (BUTTONS[key]) await idb(udid, ["button", BUTTONS[key]]);
  else if (HID_KEYS[key]) await idb(udid, ["key", HID_KEYS[key]]);
  else throw new Error(`Unknown key "${key}". One of: ${IOS_KEYS.join(", ")}.`);
}
