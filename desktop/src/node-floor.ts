// Node-floor gate + one-click in-app upgrade.
//
// The server runs on the USER'S system `node`, but the code it must run is
// OTA-updated — so an update that raises package.json engines.node would
// otherwise strand users on an old runtime with no obvious fix (the installer
// that could upgrade Node is a months-old download they no longer have).
// startServer() refuses to spawn below the floor and fires onNodeTooOld;
// main.ts routes that here: a native dialog offers an automatic upgrade,
// which runs the (OTA-updated) `scripts/install-common.mjs --upgrade-node`
// under Electron-as-node — works even when the system node is absent
// entirely, so there is no chicken-and-egg.
import { execSync, spawn } from "child_process";
import { createWriteStream, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { dialog } from "electron";

export interface NodeFloorStatus {
  ok: boolean;
  /** Major of the PATH-resolved node, or -1 when node is missing/unparseable. */
  foundMajor: number;
  requiredMajor: number;
  projectRoot: string;
  /** The augmented PATH the server spawn will use — the check and the
   *  upgrade must resolve the SAME node the spawn would. */
  pathEnv: string;
}

// engines.node (">=22") is the single source of truth for the floor — read
// from the PROJECT'S package.json (which OTA updates rewrite), not anything
// baked into the desktop shell at build time.
function readNodeFloor(projectRoot: string): number {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as { engines?: { node?: string } };
    const m = String(pkg.engines?.node ?? "").match(/(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* unreadable package.json — fall through to the known floor */ }
  return 22;
}

export function checkNodeFloor(projectRoot: string, pathEnv: string): NodeFloorStatus {
  const requiredMajor = readNodeFloor(projectRoot);
  let foundMajor = -1;
  try {
    const out = execSync("node -v", {
      env: { ...process.env, PATH: pathEnv },
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const major = Number(out.replace(/^v/, "").split(".")[0]);
    foundMajor = Number.isFinite(major) && major > 0 ? major : -1;
  } catch {
    foundMajor = -1; // node missing from PATH entirely
  }
  return { ok: foundMajor >= requiredMajor, foundMajor, requiredMajor, projectRoot, pathEnv };
}

/** Native dialog → automatic upgrade → { ok, detail }. The caller retries
 *  startServer() on ok and surfaces detail via splash recovery otherwise. */
export async function promptAndUpgradeNode(status: NodeFloorStatus): Promise<{ ok: boolean; detail: string }> {
  const found = status.foundMajor === -1
    ? "Node.js was not found on this machine"
    : `Node.js ${status.foundMajor} is installed`;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Node.js upgrade required",
    message: `Local Agent X needs Node.js ${status.requiredMajor} or newer.`,
    detail: `${found}, but this version of Local Agent X requires Node.js ${status.requiredMajor}+.\n\nUpgrade automatically now? (Uses Homebrew on macOS, winget on Windows.)`,
    buttons: ["Upgrade automatically", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return { ok: false, detail: "Node.js upgrade declined — the server can't start on this Node version." };

  const logDir = join(homedir(), ".lax", "logs");
  const logPath = join(logDir, "node-upgrade.log");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n══ node upgrade at ${new Date().toISOString()} (found ${status.foundMajor}, need ${status.requiredMajor}) ══\n`);

  const exit = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [join(status.projectRoot, "scripts", "install-common.mjs"), "--upgrade-node"], {
      cwd: status.projectRoot,
      env: { ...process.env, PATH: status.pathEnv, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (d: Buffer) => log.write(d));
    child.stderr?.on("data", (d: Buffer) => log.write(d));
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => { log.write(`spawn error: ${e.message}\n`); resolve(1); });
  });
  log.end();

  if (exit !== 0) {
    return { ok: false, detail: `Automatic upgrade failed — see ${logPath}. Install Node.js ${status.requiredMajor}+ from nodejs.org, then relaunch.` };
  }
  // Re-resolve from the same PATH the server spawn will use — "the script
  // succeeded" is not the invariant, "the spawnable node meets the floor" is.
  const recheck = checkNodeFloor(status.projectRoot, status.pathEnv);
  return recheck.ok
    ? { ok: true, detail: `Node.js ${recheck.foundMajor} installed.` }
    : { ok: false, detail: `Upgrade ran but the node on PATH is still ${recheck.foundMajor === -1 ? "missing" : `v${recheck.foundMajor}`} — see ${logPath}.` };
}
