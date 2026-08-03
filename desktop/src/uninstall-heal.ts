// Re-assert the Add/Remove Programs registration on every boot.
//
// The registration used to be written once, at install time, pointing at a
// generated script INSIDE the source tree. Rolling updates replace that tree
// wholesale, so the script disappeared and the Settings entry silently became
// a no-op: clicking Uninstall ran `powershell -File <missing>`, which exits
// immediately with nothing for the user to see. The version shown in Settings
// went stale the same way, for the same reason — write-once state describing a
// tree that keeps moving.
//
// Re-asserting here is what makes that unfixable-looking state self-correcting:
// whatever an update, a partial install or a manual delete did to the entry,
// the next launch puts it back. The uninstaller itself is staged outside the
// updatable tree (~/.lax/uninstall) so the next update cannot orphan it again.
//
// Fire-and-forget by design: this must never delay the splash or fail a boot.

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export function healUninstallRegistration(projectRoot: string): void {
  try {
    const script = join(projectRoot, "scripts", "installer", "uninstall-registration.mjs");
    if (!existsSync(script)) return;

    // ELECTRON_RUN_AS_NODE: process.execPath is Electron, not node. Same
    // pattern node-floor.ts uses to run installer .mjs from the shell — the
    // desktop bundle is CommonJS, so it cannot import an ESM .mjs directly.
    const child = spawn(process.execPath, [script, projectRoot], {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (b: Buffer) => console.log(`[uninstall-heal] ${b.toString().trim()}`));
    child.stderr?.on("data", (b: Buffer) => console.warn(`[uninstall-heal] ${b.toString().trim()}`));
    child.on("error", (e) => console.warn(`[uninstall-heal] spawn failed: ${e.message}`));
    child.unref();
  } catch (e) {
    console.warn(`[uninstall-heal] skipped: ${(e as Error).message}`);
  }
}
