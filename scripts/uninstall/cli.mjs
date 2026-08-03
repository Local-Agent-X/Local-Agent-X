// `npm run uninstall` — convenience launcher for the standalone uninstaller.
//
// The scripts in this directory are the real product; this file only picks the
// right one for the platform and forwards arguments. Anyone without a working
// checkout (the case that matters most — a broken install cannot be repaired
// through the updater) runs the script directly instead. See README.md.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, never url.pathname: a checkout under "C:\Users\...\Local Agent X"
// contains a space, which pathname leaves percent-encoded as %20.
const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const script = join(here, isWindows ? "lax-uninstall.ps1" : "lax-uninstall.sh");

if (!existsSync(script)) {
  console.error(`Uninstaller not found at ${script}`);
  process.exit(1);
}

const forwarded = process.argv.slice(2);
const { status } = isWindows
  ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...forwarded], { stdio: "inherit" })
  : spawnSync("bash", [script, ...forwarded], { stdio: "inherit" });

process.exit(status ?? 1);
