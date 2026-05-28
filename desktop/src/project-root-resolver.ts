// Self-healing PROJECT_ROOT resolution. Called from main.ts at app.ready
// when the value baked in by the installer (~/.lax/config.json's
// projectRoot field) is missing or stale.
//
// The chain is: auto-discovery (try common paths silently) → GUI dialog
// (let the user point at it) → splash error (the existing failsafe in
// main.ts).
//
// Non-technical users only see the dialog. Power users who installed via
// `install.sh` from a standard path never see anything because
// auto-discovery hits before any UI shows.

import { dialog, shell, app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { CONFIG_PATH, setProjectRoot } from "./config";

/** Candidate locations the installer is likely to have placed the repo.
 *  Order = priority. The first valid hit wins without prompting. */
function commonPaths(): string[] {
  const home = homedir();
  const out = [
    join(home, "Projects", "Local-Agent-X"),
    join(home, "Local-Agent-X"),
    join(home, "Documents", "Local-Agent-X"),
    join(home, "Desktop", "Local-Agent-X"),
    join(home, "Downloads", "Local-Agent-X"),
  ];
  // If the user dragged the .app into /Applications next to an unzipped
  // repo, check there too. app.getPath('exe') in a packaged app points to
  // <bundle>/Contents/MacOS/<binary>; the bundle's parent is /Applications.
  try {
    const appBundleParent = dirname(dirname(dirname(dirname(app.getPath("exe")))));
    out.push(join(appBundleParent, "Local-Agent-X"));
  } catch { /* dev-mode or non-Electron context */ }
  return out;
}

/** A folder qualifies as a Local Agent X repo if it has both the server
 *  entry (src/index.ts — required for tsx spawn) and a root package.json.
 *  Either alone is too weak (a stray src/ folder, an empty repo). */
function isValidProjectRoot(p: string): boolean {
  if (!p) return false;
  return (
    existsSync(join(p, "src", "index.ts")) &&
    existsSync(join(p, "package.json"))
  );
}

/** Walk common paths in priority order, return the first valid one. */
export function discoverProjectRoot(): string | null {
  for (const p of commonPaths()) {
    if (isValidProjectRoot(p)) return resolve(p);
  }
  return null;
}

/** Persist the discovered or user-picked path so the next launch is silent.
 *  Preserves any existing keys (port, authToken, etc.) by merging — we
 *  cannot rewrite the whole config from scratch. */
export function writeProjectRootToConfig(path: string): void {
  let cfg: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* clobber corrupt config */ }
  cfg.projectRoot = path;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** GUI dialog when auto-discovery fails. Returns the validated picked
 *  path, or null if the user chose Quit / cancelled / picked an invalid
 *  folder. Caller surfaces null on the splash so the user has something
 *  to act on. */
export async function promptForProjectRoot(): Promise<string | null> {
  const checked = commonPaths()
    .map((p) => `  • ${p.replace(homedir(), "~")}`)
    .join("\n");

  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Local Agent X — Setup",
    message: "Local Agent X can't find its source code.",
    detail:
      `We checked these locations:\n${checked}\n\n` +
      `If you've already downloaded the source, click "Browse folder…" ` +
      `and point at the unzipped Local-Agent-X folder ` +
      `(the one that contains src/index.ts and package.json).\n\n` +
      `If you haven't downloaded it yet, click "Open download page".`,
    buttons: ["Browse folder…", "Open download page", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });

  if (choice.response === 0) {
    const result = await dialog.showOpenDialog({
      title: "Select Local Agent X folder",
      properties: ["openDirectory"],
      message: "Choose the folder that contains src/index.ts and package.json.",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0];
    if (!isValidProjectRoot(picked)) {
      await dialog.showMessageBox({
        type: "error",
        title: "Not a Local Agent X folder",
        message: "That folder doesn't look right.",
        detail:
          `Picked: ${picked}\n\n` +
          `It needs to contain BOTH src/index.ts and package.json. ` +
          `If you unzipped the release, pick the folder that came out of the .zip — not its parent.`,
      });
      return null;
    }
    return resolve(picked);
  }

  if (choice.response === 1) {
    await shell.openExternal(
      "https://github.com/Local-Agent-X/Local-Agent-X/releases",
    );
    return null;
  }

  // Quit
  return null;
}

/** Top-level resolver — call this at app.ready when PROJECT_ROOT was null
 *  at module load. Returns the resolved path, or null if the user opted
 *  out (Quit / cancelled the picker). On success, the config file is
 *  updated AND the live config.PROJECT_ROOT getter starts returning it. */
export async function resolveAndPersistProjectRoot(): Promise<string | null> {
  const discovered = discoverProjectRoot();
  if (discovered) {
    writeProjectRootToConfig(discovered);
    setProjectRoot(discovered);
    return discovered;
  }
  const picked = await promptForProjectRoot();
  if (picked) {
    writeProjectRootToConfig(picked);
    setProjectRoot(picked);
    return picked;
  }
  return null;
}
