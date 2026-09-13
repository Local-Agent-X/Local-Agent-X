/**
 * Static tool metadata for the `android` tool — name, description, parameters
 * schema. Mirrors src/tools/browser-tools/description.ts.
 */

export const ANDROID_TOOL_NAME = "android";

export const ANDROID_TOOL_DESCRIPTION =
  "Control a REAL Android emulator for mobile app testing — start it, see its screen, and drive it with taps/swipes/text/keys. " +
  "The mobile-testing counterpart to the `browser` tool: use this for testing native Android apps (APKs), not web pages. " +
  "Requires the Android SDK; if 'list_devices'/'start_emulator' report the SDK is missing, tell the user to run the 'Set up Android SDK' " +
  "button in Settings (or the install-android-sdk script) — do not attempt to install it yourself.\n\n" +
  "WORKFLOW: start_emulator (or use an already-connected device from list_devices) → screenshot to see the screen → " +
  "tap/swipe/type_text/key_event to act → screenshot again to confirm. Most actions accept 'device' (a serial from list_devices); " +
  "when exactly one device is connected it is used automatically.\n\n" +
  "Actions:\n" +
  "- list_devices: List connected/running devices and emulators with their serials.\n" +
  "- start_emulator: Boot an AVD by name (see 'avd_name'; omit to use the default AVD created during setup). Waits for boot to finish.\n" +
  "- stop_emulator: Shut down a running emulator by 'device' serial.\n" +
  "- screenshot: Capture the current screen as a PNG, returned inline.\n" +
  "- tap: Tap at ('x', 'y') in screen pixel coordinates — use a screenshot first to find coordinates.\n" +
  "- swipe: Swipe from ('x', 'y') to ('x2', 'y2'), optionally over 'duration_ms' (default 300).\n" +
  "- type_text: Type 'text' into the currently focused input. Tap the field first.\n" +
  "- key_event: Send a hardware/soft key: 'key' is one of back, home, enter, menu, power, tab, volume_up, volume_down, app_switch, delete.\n" +
  "- install_apk: Install an APK from 'apk_path' (a workspace-relative or absolute path to a .apk file already on this machine).\n" +
  "- launch_app: Launch an installed app by 'package_name' (e.g. com.example.app).\n" +
  "- list_apps: List installed third-party packages (pass 'all_apps':true to include system packages).\n\n" +
  "TIPS:\n" +
  "- Always screenshot before tap/swipe to get current coordinates — the screen may have changed since your last observation.\n" +
  "- start_emulator can take 30-90s on first boot; it blocks until the device is ready or the boot times out.";

export const ANDROID_TOOL_COMPACT_DESCRIPTION =
  "Control a real Android emulator (mobile app testing). Workflow: start_emulator → screenshot → tap/swipe/type_text/key_event → screenshot.";

export const ANDROID_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list_devices", "start_emulator", "stop_emulator", "screenshot", "tap", "swipe", "type_text", "key_event", "install_apk", "launch_app", "list_apps"],
      description: "The android action to perform.",
    },
    device: {
      type: "string",
      description: "Device/emulator serial (from 'list_devices'). Optional when exactly one device is connected.",
    },
    avd_name: {
      type: "string",
      description: "For 'start_emulator': AVD name to boot (from a prior setup). Omit to boot the default AVD.",
    },
    x: { type: "number", description: "For 'tap'/'swipe': starting X coordinate in screen pixels." },
    y: { type: "number", description: "For 'tap'/'swipe': starting Y coordinate in screen pixels." },
    x2: { type: "number", description: "For 'swipe': ending X coordinate." },
    y2: { type: "number", description: "For 'swipe': ending Y coordinate." },
    duration_ms: { type: "number", description: "For 'swipe': swipe duration in milliseconds (default 300)." },
    text: { type: "string", description: "For 'type_text': text to type into the focused input." },
    key: {
      type: "string",
      enum: ["back", "home", "enter", "menu", "power", "tab", "volume_up", "volume_down", "app_switch", "delete"],
      description: "For 'key_event': which key to send.",
    },
    apk_path: { type: "string", description: "For 'install_apk': path to the .apk file to install." },
    package_name: { type: "string", description: "For 'launch_app': the app's package name (e.g. com.example.app)." },
    all_apps: { type: "boolean", description: "For 'list_apps': include system packages, not just third-party ones." },
  },
  required: ["action"],
};
