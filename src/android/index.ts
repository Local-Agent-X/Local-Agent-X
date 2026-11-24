/**
 * Android device-control backend — the mobile-testing counterpart to
 * src/browser/index.ts. Barrel re-export of the (deliberately small) modules
 * underneath: sdk-paths (locate the SDK), adb (device I/O), emulator
 * (process lifecycle), sdk-installer (setup), frame-stream (canvas sink feed),
 * device-hold (which chat is driving a device).
 */

export { androidSdkRoot, checkAndroidSdk, type AndroidSdkAvailability } from "./sdk-paths.js";
export {
  listDevices, resolveSerial, screenshot, tap, swipe, typeText, keyEvent,
  installApk, listApps, launchApp, reversePort, openUrl, KEY_EVENTS, dumpLog, deviceInfo,
  type AndroidDevice, type InstalledApp, type DeviceInfo,
} from "./adb.js";
export { listAvds, startEmulator, stopEmulator, runningEmulators } from "./emulator.js";
export { installAndroidSdk, getSdkStatus, type InstallProgress } from "./sdk-installer.js";
export { startFrameStream, type FrameStreamHandle } from "./frame-stream.js";
export { holdDevice, deviceHolder, releaseDevice, HOLD_IDLE_MS } from "./device-hold.js";
