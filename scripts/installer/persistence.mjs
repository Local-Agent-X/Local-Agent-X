import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeDurableJson } from "./checkpoint.mjs";
import { bindInstallerDataRoot, mutateInstallerDataRoot } from "./data-root.mjs";

export function persistInstallOutcome(context, desktop) {
  const { reporter, env = process.env, platform = process.platform } = context;
  const dataDirectory = context.dataDirectory || join(homedir(), ".lax");
  context.dataDirectory = dataDirectory;
  if (!context.installerDataRootIdentity) bindInstallerDataRoot(context);
  const installedCommit = env.LAX_INSTALLED_COMMIT || "";
  if (/^[0-9a-f]{40}$/.test(installedCommit)) {
    try {
      mutateInstallerDataRoot(context, ["installed-source.json"], () => {
        mkdirSync(dataDirectory, { recursive: true });
        writeDurableJson(join(dataDirectory, "installed-source.json"), { commit: installedCommit, updatedAt: new Date().toISOString() });
      });
      reporter.ok(`Recorded installed source commit ${installedCommit.slice(0, 7)}`);
    } catch (error) { reporter.warn(`Couldn't record installed source commit: ${error.message}`); }
  }
  let reportSaved = false;
  try {
    mutateInstallerDataRoot(context, ["install-report.json"], () => {
      mkdirSync(dataDirectory, { recursive: true });
      writeDurableJson(join(dataDirectory, "install-report.json"), {
        installedAt: new Date().toISOString(),
        selections: context.selections || {
          ollamaRuntime: Boolean(context.wantOllama),
          ollamaMemoryModel: Boolean(context.wantOllamaMemoryModel),
        },
        hardwareProfile: context.hardwareProfile || null,
        degraded: reporter.degraded,
      });
    });
    reportSaved = true;
    if (reporter.degraded.length) reporter.ok(`Recorded ${reporter.degraded.length} degraded step(s) for in-app repair`);
  } catch (error) { reporter.warn(`Couldn't record the install report: ${error.message}`); }

  reporter.ipc({ type: "complete" });
  if (!reporter.ipcMode) console.log("");
  reporter.log("Install complete.");
  if (reporter.degraded.length) {
    reporter.log("");
    reporter.log(`Installed with ${reporter.degraded.length} optional component(s) unavailable:`);
    for (const item of reporter.degraded) reporter.log(`  • [${item.step}] ${item.message}`);
    reporter.log("  The app works without these — re-run the installer once resolved to enable them.");
  }
  if (desktop.appInstalled && platform === "darwin") {
    reporter.log("  Launch:      open Launchpad, click \"Local Agent X\"");
    reporter.log("  First time:  right-click the icon → Open → Open (one-time Gatekeeper prompt)");
    reporter.log("  Close-X:     keeps server running in the menu bar; use the tray menu to Quit");
  } else if (desktop.appInstalled && platform === "win32") {
    reporter.log("  Launch:      double-click \"Local Agent X\" on your Desktop or Start Menu");
    reporter.log("  First time:  Windows may show SmartScreen — click \"More info\" → \"Run anyway\"");
  } else if (platform === "darwin" && desktop.appBuildPath) {
    reporter.log(`  App built at: ${desktop.appBuildPath} (drag to /Applications manually)`);
  }
  reporter.log("  CLI (headless): npm run dev   →   http://127.0.0.1:7007");
  return reportSaved;
}
