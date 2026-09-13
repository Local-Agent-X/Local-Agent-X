/**
 * install_apk / launch_app / list_apps — app management via `adb install` /
 * `adb shell monkey` / `adb shell pm list packages`.
 */

import { existsSync } from "node:fs";
import type { ToolResult } from "../../types.js";
import { resolveSerial, installApk, launchApp, listApps } from "../../android/index.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { ok, err } from "../result-helpers.js";

export async function handleInstallApk(args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = args.apk_path ? String(args.apk_path) : "";
  if (!rawPath) return err("'apk_path' is required for install_apk.");
  // Must match the path evaluateFileAccess (tool-policies.apps.ts pathArgs)
  // re-derived from the same raw arg — resolveAgentPath is that canonical step.
  const apkPath = resolveAgentPath(rawPath);
  if (!existsSync(apkPath)) return err(`APK not found at "${apkPath}".`);
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  const output = await installApk(serial, apkPath);
  return ok(`Installed ${apkPath} on ${serial}.\n${output.trim()}`);
}

export async function handleLaunchApp(args: Record<string, unknown>): Promise<ToolResult> {
  const packageName = args.package_name ? String(args.package_name) : "";
  if (!packageName) return err("'package_name' is required for launch_app.");
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  await launchApp(serial, packageName);
  return ok(`Launched ${packageName} on ${serial}.`);
}

export async function handleListApps(args: Record<string, unknown>): Promise<ToolResult> {
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  const apps = await listApps(serial, args.all_apps !== true);
  if (apps.length === 0) return ok("No packages found.");
  return ok(apps.map((a) => a.packageName).join("\n"));
}
