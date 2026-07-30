import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function windowsDesktopCandidates({ env = process.env, homeDirectory = homedir() } = {}) {
  const localAppData = env.LOCALAPPDATA || join(homeDirectory, "AppData", "Local");
  return [
    // electron-builder 25 uses the sanitized package name for one-click,
    // per-user NSIS installs (desktop/package.json name).
    join(localAppData, "Programs", "local-agent-x-desktop", "LocalAgentX.exe"),
    // Preserve discovery of older/manual builds that used productName.
    join(localAppData, "Programs", "Local Agent X", "LocalAgentX.exe"),
  ];
}

export function findWindowsDesktop(options = {}) {
  return windowsDesktopCandidates(options)
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null;
}
