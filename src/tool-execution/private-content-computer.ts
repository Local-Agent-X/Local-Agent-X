// What a `computer` keystroke carries and where it lands, for the private-
// content gate (private-content-gate.ts). Typing sends the typed text; a paste
// chord sends whatever is on the clipboard, which the call's own args never
// show. Either lands in the window that has the foreground, which the OS can
// name but not resolve to a web address, so the gate treats it as a
// destination of its own.

import { execFile } from "node:child_process";
import { clipboardTools } from "../tools/clipboard-tools.js";
import { familyActionArgs } from "../tools/shared/collapse-family.js";

export interface ForegroundApp { name: string; title: string }

/** A paste chord's clipboard could not be read. The paste may carry anything
 *  the session read, so the gate asks about it instead of reading it as empty. */
export class UnreadableClipboardError extends Error {
  constructor() {
    super("the clipboard could not be read");
    this.name = "UnreadableClipboardError";
  }
}

const QUERY_TIMEOUT_MS = 3000;

/** A chord that pastes: V with a modifier (Ctrl/Cmd/Shift and the paste-plain
 *  variants), or Shift+Insert. Matched on the keys alone, not on modifier
 *  spellings, so an alias the input driver learns later still counts. */
export function isPasteChord(keys: unknown): boolean {
  if (!Array.isArray(keys)) return false;
  const k = keys.map((x) => String(x).trim().toLowerCase());
  return (k.length > 1 && k.includes("v")) || (k.includes("shift") && k.includes("insert"));
}

/** The text a `computer` call would put into the foreground app. The family
 *  picks the action from the top-level `action` but runs it with
 *  familyActionArgs, where a `params` object the schema never validated
 *  overrides the flat text and keys. Read here any other way, a secret nested
 *  under `params` is typed while the gate judges the empty flat field. The
 *  text is stringified as the type action stringifies it. */
export async function computerPayload(args: Record<string, unknown>, clipboardText: () => Promise<string>): Promise<string> {
  const action = String(args.action ?? "").toLowerCase();
  const run = familyActionArgs(args);
  if (action === "type") return String(run.text ?? "");
  if (action === "press" && isPasteChord(run.keys)) return clipboardText();
  return "";
}

/** The clipboard's text, read the way clipboard_read reads it. Throws
 *  UnreadableClipboardError where it cannot be read (no clipboard program on
 *  this machine, or the read failed): a paste of unknown text is not empty. */
export async function readClipboardText(): Promise<string> {
  const read = clipboardTools.find((t) => t.name === "clipboard_read");
  const result = await read?.execute({});
  if (!result || result.isError || typeof result.content !== "string") throw new UnreadableClipboardError();
  return result.content;
}

// Windows: the computer tool's own input library, a native addon, reads the
// focused window. A generated PowerShell script declaring the same user32
// calls is what AMSI scans for and can block. The addon gives the window's
// title, not its process, so the card names it as a window by that title.
async function focusedWindow(): Promise<ForegroundApp | null> {
  try {
    const { getActiveWindow } = await import("@nut-tree-fork/nut-js");
    const title = await (await getActiveWindow()).title;
    return title ? { name: "the window", title } : null;
  } catch {
    return null; // the addon did not load or the OS refused the read: the destination is unknown, and the gate says so
  }
}

const MAC_QUERY = 'tell application "System Events" to get name of first application process whose frontmost is true';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout.trim()));
  });
}

/** The app that has the foreground, or null where the OS will not say. */
export async function queryForegroundApp(): Promise<ForegroundApp | null> {
  if (process.platform === "win32") return focusedWindow();
  if (process.platform === "darwin") {
    const name = await run("osascript", ["-e", MAC_QUERY]);
    return name ? { name, title: "" } : null;
  }
  return null;
}
