// Detects whether the OS's currently focused UI element is a text-editable
// control, so the live-screen session can tell the phone to raise/dismiss its
// soft keyboard automatically (tap a text field on the desktop → keyboard opens).
//
// There is no nut.js API for focused-element introspection and we don't want a
// new native addon, so each platform shells out to its accessibility/automation
// surface — the same approach the Windows screen paths already take (PowerShell
// for the capture geometry). Best-effort by design: any failure resolves to
// `false`, and a persistently-denied read self-disables the probe so we don't
// spawn a process on every click for a capability the OS won't grant.
//
// macOS caveat: the AppleScript path reads the AX tree via System Events, which
// needs an Accessibility grant for THIS read (separate from the Automation
// prompt). When that grant is missing the read errors (-1728) — surfaced here as
// "err" so the caller can tell a denied read from a genuine "not a text field".

import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.focus");

const QUERY_TIMEOUT_MS = 2000;
/** Consecutive denied/failed reads before we give up probing for this run. */
const MAX_CONSECUTIVE_ERRORS = 3;

// macOS: the frontmost process's AXFocusedUIElement role, read via System Events
// (AppleScript is the only AX path without a native addon). Returns "1" for an
// editable role, "0" for anything else, and "err" when the AX read itself fails
// (no focused element, or — the common case — a missing Accessibility grant).
// "contains Text" catches AXTextField/AXTextArea/AXSecureTextField (web inputs and
// Electron editors report these too); AXStaticText is a label, so it's excluded.
const MAC_SCRIPT = `tell application "System Events"
  try
    set r to (get value of attribute "AXRole" of (value of attribute "AXFocusedUIElement" of (first application process whose frontmost is true)))
  on error
    return "err"
  end try
  if ((r contains "Text") and r is not "AXStaticText") or (r is in {"AXComboBox", "AXSearchField"}) then
    return "1"
  end if
  return "0"
end tell`;

// Windows: UI Automation's FocusedElement control type. Edit/Document are the
// text-entry controls. Prints "1"/"0" to match the macOS path; a thrown read
// (no UIA / no focus) surfaces as a non-zero exit → "err" below.
const WIN_SCRIPT =
  "Add-Type -AssemblyName UIAutomationClient;" +
  "$f=[System.Windows.Automation.AutomationElement]::FocusedElement;" +
  "if($f){$c=$f.Current.ControlType.ProgrammaticName;" +
  "if($c -eq 'ControlType.Edit' -or $c -eq 'ControlType.Document'){'1'}else{'0'}}else{'0'}";

let disabled = false;
let consecutiveErrors = 0;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? "err" : stdout.trim());
    });
  });
}

/** True when the OS-focused element is a text-editable control. Best-effort:
 *  returns false on an unsupported platform, a non-text element, or a failed
 *  read — and stops probing after repeated failures (re-enabled on next run). */
export async function queryEditableFocus(): Promise<boolean> {
  if (disabled) return false;

  let result: string;
  if (process.platform === "darwin") {
    result = await run("osascript", ["-e", MAC_SCRIPT]);
  } else if (process.platform === "win32") {
    result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT]);
  } else {
    disabled = true;
    return false;
  }

  if (result === "err" || result === "") {
    if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      disabled = true;
      logger.warn(
        "[screen-stream] focus probe disabled after repeated failed reads — the OS " +
          "denied the focused-element query. Grant Accessibility (macOS) / UI Automation " +
          "access and restart to re-enable the auto-keyboard.",
      );
    }
    return false;
  }

  consecutiveErrors = 0;
  return result === "1";
}
