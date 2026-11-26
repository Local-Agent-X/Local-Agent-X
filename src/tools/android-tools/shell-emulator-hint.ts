/**
 * The note a shell command gets when it boots an Android emulator itself.
 *
 * The `android` tool's start_emulator boots without a window and feeds the
 * app's Android tab (android/emulator.ts). The SDK's own `emulator -avd …`,
 * run through the shell, opens a window on the user's desktop and shows
 * nothing in the app: a build worker ran exactly that, and its emulator sat
 * on screen for two days while the tab built for watching it stayed empty
 * (2026-11-24). The command is not refused, since a script may need a flag
 * the tool does not pass; the result says which way the app can show.
 */

/** `emulator` (bare, a path to it, or .exe) asked to boot an AVD: `-avd <name>`
 *  or the `@name` shorthand. Listing AVDs, a version or help boots nothing. */
const BOOTS_AN_AVD = /(?:^|[\s"'`(;&|\\/])emulator(?:\.exe)?["']?\s+(?:[^|;&\n]*?\s)?(?:-avd\s+\S|@[\w.-]+)/i;

export function shellEmulatorHint(command: string): string | null {
  if (!BOOTS_AN_AVD.test(command)) return null;
  return (
    "This boots an Android emulator outside the app: it opens its own window on the user's desktop, and the app's Android tab shows " +
    "nothing of it until the android tool acts on that device. To boot one the app shows and keeps track of, use the android tool " +
    "(action start_emulator); one that is already running can be driven with the android tool as it is."
  );
}
