/**
 * The `ios` tool: one tool with an `action`, dispatching to src/ios. Every
 * action states what it needs (a Mac, a Simulator, an iPhone) and says so in
 * words instead of failing deep inside a spawn.
 */
import type { ToolDefinition, ToolResult } from "../../types.js";
import { err, ok } from "../result-helpers.js";
import { deviceScreenshotResult } from "../android-tools/capture.js";
import {
  IS_MAC, NEEDS_A_MAC, bootSimulator, installOnIphone, installSimulatorApp, launchOnIphone, launchSimulatorApp, listIosTargets,
  openSimulatorUrl, resolveIosTarget, simulatorHasApp, simulatorKey, simulatorScreenshot, simulatorSwipe, simulatorTap,
  simulatorType, usbIphoneApps, usbIphoneScreenshot, type IosTarget,
} from "../../ios/index.js";
import { IOS_ACTIONS, IOS_TOOL_COMPACT_DESCRIPTION, IOS_TOOL_DESCRIPTION, IOS_TOOL_NAME, IOS_TOOL_PARAMETERS } from "./description.js";

const READ_ONLY = new Set(["list_devices", "screenshot", "list_apps"]);
const SIMULATOR_ONLY = new Set(["tap", "swipe", "type_text", "key_event", "open_url"]);
const MAC_ONLY = new Set(["boot_simulator", "install_app", "launch_app", ...SIMULATOR_ONLY]);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number.`);
  return n;
};
const describeTarget = (t: IosTarget) => `${t.kind === "simulator" ? "Simulator" : "iPhone"} ${t.name} (${t.os}, ${t.udid})`;

async function listDevices(): Promise<ToolResult> {
  const { targets, missing } = await listIosTargets();
  const lines = targets.map((t) => `- ${describeTarget(t)}${t.kind === "simulator" ? (t.booted ? ", booted" : "") : `, ${t.model}`}`);
  const notes = [...(IS_MAC ? [] : [NEEDS_A_MAC]), ...missing];
  return ok(`${lines.length ? lines.join("\n") : "No iOS Simulator or USB iPhone found."}${notes.length ? `\n\n${notes.join("\n")}` : ""}`);
}

async function onTarget(action: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t = await resolveIosTarget(str(args.device));
  if (SIMULATOR_ONLY.has(action) && t.kind !== "simulator") {
    return err(`${action} drives a Simulator; ${describeTarget(t)} is a real iPhone, which Apple does not let a tool tap. Test the flow on a Simulator, or ask the user to do this step on the phone in exact words.`);
  }
  switch (action) {
    case "screenshot":
      return deviceScreenshotResult(t.kind === "simulator" ? await simulatorScreenshot(t.udid) : await usbIphoneScreenshot(t.udid), "ios", describeTarget(t));
    case "tap": await simulatorTap(t.udid, num(args.x, "x"), num(args.y, "y")); return ok(`Tapped (${args.x}, ${args.y}) on ${t.name}.`);
    case "swipe":
      await simulatorSwipe(t.udid, num(args.x, "x"), num(args.y, "y"), num(args.x2, "x2"), num(args.y2, "y2"), args.duration_ms ? num(args.duration_ms, "duration_ms") : undefined);
      return ok(`Swiped on ${t.name}.`);
    case "type_text": await simulatorType(t.udid, String(args.text ?? "")); return ok(`Typed into ${t.name}.`);
    case "key_event": await simulatorKey(t.udid, String(args.key ?? "")); return ok(`Pressed ${args.key} on ${t.name}.`);
    case "open_url": await openSimulatorUrl(t.udid, String(args.url ?? "")); return ok(`Opened ${args.url} on ${t.name}.`);
    case "install_app": {
      const path = str(args.app_path);
      if (!path) return err("install_app needs 'app_path'.");
      await (t.kind === "simulator" ? installSimulatorApp(t.udid, path) : installOnIphone(t.udid, path));
      return ok(`Installed ${path} on ${describeTarget(t)}.`);
    }
    case "launch_app": {
      const id = str(args.bundle_id);
      if (!id) return err("launch_app needs 'bundle_id'.");
      await (t.kind === "simulator" ? launchSimulatorApp(t.udid, id) : launchOnIphone(t.udid, id));
      return ok(`Launched ${id} on ${describeTarget(t)}.`);
    }
    case "list_apps": {
      const id = str(args.bundle_id);
      if (t.kind === "simulator") {
        if (!id) return err("On a Simulator, list_apps answers for one app: pass 'bundle_id'.");
        return ok(`${id} is ${(await simulatorHasApp(t.udid, id)) ? "" : "not "}installed on ${t.name}.`);
      }
      const apps = await usbIphoneApps(t.udid);
      return ok(id ? `${id} is ${apps.includes(id) ? "" : "not "}installed on ${t.name}.` : apps.sort().join("\n"));
    }
    default: return err(`Unknown action "${action}".`);
  }
}

export function createIosTools(): ToolDefinition[] {
  const iosTool: ToolDefinition = {
    name: IOS_TOOL_NAME,
    effect: (args) => READ_ONLY.has(String(args.action || "")) ? { class: "read-only" } : { class: "non-idempotent" },
    description: IOS_TOOL_DESCRIPTION,
    compactDescription: IOS_TOOL_COMPACT_DESCRIPTION,
    parameters: IOS_TOOL_PARAMETERS,
    async execute(args) {
      const action = String(args.action || "");
      if (!(IOS_ACTIONS as readonly string[]).includes(action)) return err(`Unknown action "${action}". Valid: ${IOS_ACTIONS.join(", ")}.`);
      if (!IS_MAC && MAC_ONLY.has(action)) return err(`${action}: ${NEEDS_A_MAC}`);
      try {
        if (action === "list_devices") return await listDevices();
        if (action === "boot_simulator") {
          const sim = await bootSimulator(str(args.device) ?? str(args.name) ?? "iPhone 16");
          return ok(`Booted Simulator ${sim.name} (${sim.os}, ${sim.udid}).`);
        }
        return await onTarget(action, args);
      } catch (e) {
        return err(`iOS error: ${(e as Error).message}`);
      }
    },
  };
  return [iosTool];
}
