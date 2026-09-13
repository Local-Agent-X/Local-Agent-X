/**
 * adb bridge — device enumeration, input actuation, app management, and
 * screen capture. One thin wrapper per adb subcommand; no session/state here
 * (emulator.ts owns process lifecycle, index.ts is the tool-facing facade).
 */

import { runAdb, runAdbText } from "./adb-run.js";

export interface AndroidDevice {
  serial: string;
  state: string; // "device" | "offline" | "unauthorized" | ...
  model?: string;
}

export async function listDevices(): Promise<AndroidDevice[]> {
  const out = await runAdbText(["devices", "-l"]);
  const lines = out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const modelField = rest.find((f) => f.startsWith("model:"));
    return { serial, state, model: modelField?.slice("model:".length) };
  });
}

/** Resolves a caller-supplied serial, or the sole connected device when omitted. */
export async function resolveSerial(serial?: string): Promise<string> {
  if (serial) return serial;
  const devices = await listDevices();
  const online = devices.filter((d) => d.state === "device");
  if (online.length === 0) throw new Error("No Android device/emulator is connected. Use 'start_emulator' or 'list_devices' first.");
  if (online.length > 1) throw new Error(`Multiple devices connected (${online.map((d) => d.serial).join(", ")}) — pass 'device' to pick one.`);
  return online[0].serial;
}

export async function screenshot(serial: string): Promise<Buffer> {
  // exec-out screencap -p over adb is simpler and more reliable than wiring up
  // scrcpy's video pipeline for a single still — this tool only needs
  // request/response frames, not continuous mirroring.
  const result = await runAdb(["-s", serial, "exec-out", "screencap", "-p"], 20_000);
  if (result.code !== 0 || result.stdout.length === 0) {
    throw new Error(result.stderr.trim() || "adb screencap returned no data");
  }
  return result.stdout;
}

export async function tap(serial: string, x: number, y: number): Promise<void> {
  await runAdbText(["-s", serial, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
}

export async function swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
  await runAdbText(["-s", serial, "shell", "input", "swipe",
    String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))]);
}

// `input text` treats a literal space as a token separator, so it must be
// escaped as %s; the shell layer underneath also needs quote/backslash
// characters escaped or the string gets split before adb ever sees it.
function escapeInputText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/(["'$`])/g, "\\$1").replace(/ /g, "%s");
}

export async function typeText(serial: string, text: string): Promise<void> {
  await runAdbText(["-s", serial, "shell", "input", "text", escapeInputText(text)]);
}

export const KEY_EVENTS: Record<string, string> = {
  back: "KEYCODE_BACK", home: "KEYCODE_HOME", enter: "KEYCODE_ENTER",
  menu: "KEYCODE_MENU", power: "KEYCODE_POWER", tab: "KEYCODE_TAB",
  volume_up: "KEYCODE_VOLUME_UP", volume_down: "KEYCODE_VOLUME_DOWN",
  app_switch: "KEYCODE_APP_SWITCH", delete: "KEYCODE_DEL",
};

export async function keyEvent(serial: string, key: string): Promise<void> {
  const code = KEY_EVENTS[key];
  if (!code) throw new Error(`Unknown key "${key}". Valid keys: ${Object.keys(KEY_EVENTS).join(", ")}`);
  await runAdbText(["-s", serial, "shell", "input", "keyevent", code]);
}

export async function installApk(serial: string, apkPath: string): Promise<string> {
  return runAdbText(["-s", serial, "install", "-r", apkPath], 120_000);
}

export interface InstalledApp {
  packageName: string;
}

export async function listApps(serial: string, thirdPartyOnly = true): Promise<InstalledApp[]> {
  const args = ["-s", serial, "shell", "pm", "list", "packages"];
  if (thirdPartyOnly) args.push("-3");
  const out = await runAdbText(args);
  return out.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => ({ packageName: l.slice("package:".length) }));
}

export async function launchApp(serial: string, packageName: string): Promise<void> {
  // monkey's LAUNCHER-category intent starts an app by package alone — no
  // caller-supplied launch activity needed, unlike `am start -n pkg/activity`.
  // On failure (package not installed / no launchable activity) monkey exits
  // non-zero, but the useful diagnosis ("No activities found ... aborted") is
  // on STDOUT — stderr is just an echo of the args we already passed it. Using
  // runAdbText here would throw with that useless arg-echo as the message.
  const result = await runAdb(["-s", serial, "shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
  const stdout = result.stdout.toString("utf8");
  if (result.code !== 0 || /no activities found|aborted/i.test(stdout)) {
    throw new Error(`"${packageName}" has no launchable activity on ${serial} — it isn't installed. Use 'list_apps' to check, or 'install_apk' to sideload it.`);
  }
}

/** `adb reverse` — exposes a port on this machine (e.g. a Metro/Expo dev
 *  server) to the emulator at the same-numbered port on its own loopback, so
 *  an app on the device can reach a dev server that only listens on the host.
 *  This is the bridge a local Expo/React-Native workflow needs; there is no
 *  equivalent for reaching an arbitrary LAN host, only the host machine. */
export async function reversePort(serial: string, port: number): Promise<void> {
  await runAdbText(["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
}

export async function openUrl(serial: string, url: string): Promise<void> {
  await runAdbText(["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
}
