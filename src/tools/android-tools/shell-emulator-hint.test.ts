// A shell command that boots an emulator itself opens a window the app does
// not show; its result points at the android tool. Anything else is left alone.
import { describe, expect, it } from "vitest";
import { shellEmulatorHint } from "./shell-emulator-hint.js";

describe("shellEmulatorHint", () => {
  it.each([
    // The command a build worker ran, verbatim (2026-11-24).
    'cd "C:/Users/p/AppData/Local/Temp/lax-worktrees/autobuild-c1-2" && (emulator -avd lax_default -read-only -no-snapshot -no-boot-anim > .local/emulator-c1.log 2>&1 </dev/null &)',
    "emulator -avd Pixel_8",
    "emulator @Pixel_8 -no-snapshot",
    '"C:/Users/p/AppData/Local/Android/Sdk/emulator/emulator.exe" -no-audio -avd lax_default',
    "$ANDROID_HOME/emulator/emulator -avd lax_default &",
    "nohup emulator -gpu host -avd lax_default &",
  ])("names the android tool for %s", (command) => {
    expect(shellEmulatorHint(command)).toMatch(/android tool \(action start_emulator\)/);
  });

  it.each([
    "emulator -list-avds",
    "emulator -version",
    "adb -s emulator-5554 shell getprop sys.boot_completed",
    "adb devices | grep emulator",
    "firebase emulators:start --only firestore",
    "npx expo run:android",
    "ls ~/Android/Sdk/emulator",
  ])("says nothing for %s", (command) => {
    expect(shellEmulatorHint(command)).toBeNull();
  });
});
