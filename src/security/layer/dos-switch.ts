// A DOS-style switch: `/s`, `/q`, `/T:30`. On win32 it has the same shape as a path at
// the drive root, and the shell path guard deliberately treats it as one outside the
// few verbs it shields (shell-path-guard.ts, WINDOWS_SLASH_SWITCH_COMMANDS).
export const DOS_SWITCH = /^\/[A-Za-z?][A-Za-z0-9?-]*(?::[^\\/]*)?$/;

/** The refusal for that deliberate false block (`rd /s /q x`), when the token is
 *  switch-shaped on win32; null otherwise. Reported as a path outside the boundary,
 *  the model told the user a folder inside the workspace was outside it. */
export function dosSwitchBlockReason(token: string, fileAccessMode: string): string | null {
  if (process.platform !== "win32" || !DOS_SWITCH.test(token)) return null;
  return `Blocked, nothing ran: "${token}" is probably a Windows switch, but this check cannot tell a switch `
    + `from a path at the drive root, which is outside the ${fileAccessMode} file-access boundary. The path the `
    + `command names may well be inside the workspace. To delete a file or folder, use delete_file (it asks the `
    + `user, and the trash can undo it). For other commands, use the dash-style option if the command has one.`;
}
