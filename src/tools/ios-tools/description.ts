/**
 * Static metadata for the `ios` tool: the iPhone counterpart to the `android`
 * tool, with the same action names where they mean the same thing.
 */
import { IOS_KEYS } from "../../ios/idb.js";

export const IOS_TOOL_NAME = "ios";

export const IOS_ACTIONS = [
  "list_devices", "boot_simulator", "screenshot", "tap", "swipe", "type_text", "key_event", "install_app", "launch_app", "list_apps", "open_url",
] as const;

export const IOS_TOOL_DESCRIPTION =
  "Drive an iOS Simulator or a USB-connected iPhone to test a mobile app: see its screen, tap, type, install and launch it. " +
  "The iPhone counterpart to the `android` tool.\n\n" +
  "WHAT WORKS WHERE (Apple's tools decide this): on a Mac, everything: the Simulator (boot_simulator, install_app, launch_app, " +
  "open_url, screenshot, tap/swipe/type_text/key_event) and a USB iPhone (screenshot, list_apps, install_app, launch_app). On " +
  "Windows, only a USB iPhone's list_devices, screenshot and list_apps: there is no iOS Simulator off macOS and no way to tap " +
  "or install. On Windows, say so and test on Android, or ask the user to run the iOS part on their Mac.\n\n" +
  "WORKFLOW: list_devices → boot_simulator (Mac) → install_app the built .app → launch_app → screenshot → tap/type_text → " +
  "screenshot again. Tap coordinates are the Simulator's points, from the screenshot. 'device' is a udid from list_devices; " +
  "when exactly one iPhone or booted Simulator is present it is used.\n\n" +
  "Actions:\n" +
  "- list_devices: the Simulators (Mac) and USB iPhones this machine sees, and any tool that is missing.\n" +
  "- boot_simulator: boot one by 'name' or 'device' udid and wait until it is ready (Mac).\n" +
  "- screenshot: the current screen, shown to you inline.\n" +
  "- tap ('x','y'), swipe ('x','y' to 'x2','y2', 'duration_ms'), type_text ('text'), key_event ('key': " + IOS_KEYS.join(", ") + "): Simulator, Mac.\n" +
  "- install_app: install 'app_path' (a Simulator .app, or a signed .app/.ipa for an iPhone) (Mac).\n" +
  "- launch_app: start 'bundle_id' (Mac). list_apps: whether 'bundle_id' is installed, or the iPhone's app list.\n" +
  "- open_url: open 'url' (a web page or a deep link like 'exp://127.0.0.1:8081') in the Simulator (Mac).\n\n" +
  "TESTING A PHONE APP YOU BUILT OR CHANGED: drive every flow you touched on the Simulator yourself before asking the user " +
  "anything (the happy path, a permission denied, bad input) on a debug build whose own log lines show. Use the user's real " +
  "iPhone only for what a Simulator cannot do (the camera, on-device AI), and ask for that step in exact words. Then run " +
  "device_check with platform 'ios'.";

export const IOS_TOOL_COMPACT_DESCRIPTION =
  "Drive an iOS Simulator (Mac) or a USB iPhone: list_devices, boot_simulator, screenshot, tap, type_text, install_app, launch_app.";

export const IOS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...IOS_ACTIONS], description: "The ios action to perform." },
    device: { type: "string", description: "A Simulator or iPhone udid from list_devices. Optional when exactly one is in use." },
    name: { type: "string", description: "boot_simulator: the Simulator's name, e.g. 'iPhone 16'." },
    x: { type: "number" }, y: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
    duration_ms: { type: "number", description: "swipe: how long, in milliseconds (default 300)." },
    text: { type: "string", description: "type_text: the text to type into the focused field." },
    key: { type: "string", enum: IOS_KEYS, description: "key_event: the key or button." },
    app_path: { type: "string", description: "install_app: path to the .app (Simulator) or signed .app/.ipa (iPhone)." },
    bundle_id: { type: "string", description: "launch_app / list_apps: the app's bundle id, e.g. app.labelcheck." },
    url: { type: "string", description: "open_url: the URL or deep link." },
  },
  required: ["action"],
} as const;
