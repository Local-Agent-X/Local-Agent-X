/**
 * tap / swipe / type_text / key_event — input actuation via `adb shell input`.
 */

import type { ToolResult } from "../../types.js";
import { resolveSerial, tap, swipe, typeText, keyEvent, KEY_EVENTS } from "../../android/index.js";
import { ok, err } from "../result-helpers.js";

export async function handleTap(args: Record<string, unknown>): Promise<ToolResult> {
  if (args.x === undefined || args.y === undefined) return err("'x' and 'y' are required for tap.");
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  await tap(serial, Number(args.x), Number(args.y));
  return ok(`Tapped (${args.x}, ${args.y}) on ${serial}.`);
}

export async function handleSwipe(args: Record<string, unknown>): Promise<ToolResult> {
  if (args.x === undefined || args.y === undefined || args.x2 === undefined || args.y2 === undefined) {
    return err("'x', 'y', 'x2', and 'y2' are required for swipe.");
  }
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  const duration = args.duration_ms !== undefined ? Number(args.duration_ms) : undefined;
  await swipe(serial, Number(args.x), Number(args.y), Number(args.x2), Number(args.y2), duration);
  return ok(`Swiped (${args.x}, ${args.y}) -> (${args.x2}, ${args.y2}) on ${serial}.`);
}

export async function handleTypeText(args: Record<string, unknown>): Promise<ToolResult> {
  const text = args.text !== undefined ? String(args.text) : "";
  if (!text) return err("'text' is required for type_text.");
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  await typeText(serial, text);
  return ok(`Typed text on ${serial}.`);
}

export async function handleKeyEvent(args: Record<string, unknown>): Promise<ToolResult> {
  const key = args.key ? String(args.key) : "";
  if (!key) return err(`'key' is required for key_event. Valid keys: ${Object.keys(KEY_EVENTS).join(", ")}`);
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  await keyEvent(serial, key);
  return ok(`Sent key "${key}" to ${serial}.`);
}
