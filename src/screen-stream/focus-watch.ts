// Detects whether the OS's currently focused UI element is a text-editable
// control, so the live-screen session can tell the phone to raise/dismiss its
// soft keyboard automatically (tap a text field on the desktop → keyboard opens).
//
// There is no nut.js API for focused-element introspection and we don't want a
// new native addon, so each platform shells out to its accessibility/automation
// surface — the same approach the Windows screen paths already take (PowerShell
// for the capture geometry). Best-effort by design: any failure (a missing
// Automation/AX grant, an app that doesn't expose its tree, a timeout) resolves
// to `false`, so the feature degrades to "no auto-keyboard" instead of breaking
// the session.

import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.focus");

const QUERY_TIMEOUT_MS = 2000;

// macOS: the frontmost process's AXFocusedUIElement role, read via System Events
// (AppleScript is the only AX path without a native addon). Prints "1" for an
// editable role, "0" otherwise. Needs the Automation grant for System Events.
const MAC_SCRIPT = `tell application "System Events"
  set r to "none"
  try
    set r to (get value of attribute "AXRole" of (value of attribute "AXFocusedUIElement" of (first application process whose frontmost is true)))
  end try
  if r is in {"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"} then
    return "1"
  end if
  return "0"
end tell`;

// Windows: UI Automation's FocusedElement control type. Edit/Document are the
// text-entry controls. Prints "1"/"0" to match the macOS path.
const WIN_SCRIPT =
  "Add-Type -AssemblyName UIAutomationClient;" +
  "$f=[System.Windows.Automation.AutomationElement]::FocusedElement;" +
  "if($f){$c=$f.Current.ControlType.ProgrammaticName;" +
  "if($c -eq 'ControlType.Edit' -or $c -eq 'ControlType.Document'){'1'}else{'0'}}else{'0'}";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

/** True when the OS-focused element is a text-editable control. Best-effort:
 *  returns false on an unsupported platform or on any failure. */
export async function queryEditableFocus(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      return (await run("osascript", ["-e", MAC_SCRIPT])) === "1";
    }
    if (process.platform === "win32") {
      return (
        (await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT])) === "1"
      );
    }
  } catch (e) {
    logger.warn(`[screen-stream] focus probe failed: ${(e as Error).message}`);
  }
  return false;
}
