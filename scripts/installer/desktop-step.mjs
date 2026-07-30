import { installMacDesktop } from "./mac-desktop.mjs";
import { installWindowsDesktop } from "./windows-desktop.mjs";

export async function runDesktopStep(context) {
  const { reporter, platform = process.platform } = context;
  const detail = ["darwin", "win32"].includes(platform) ? "Signed desktop app download and install" : null;
  if (!reporter.step("desktop", detail)) {
    return reporter.resumedStepResult("desktop") || { appInstalled: false, appBuildPath: null };
  }
  let result = { appInstalled: false, appBuildPath: null };
  if (platform === "darwin") result = await installMacDesktop(context);
  else if (platform === "win32") result = await installWindowsDesktop(context);
  else reporter.log("(Linux: no native app target yet — use `npm run dev` to launch the server.)");
  reporter.stepDone("desktop", result);
  return result;
}
