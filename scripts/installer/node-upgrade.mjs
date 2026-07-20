import { NODE_LTS_INSTALL, WINGET_SOURCE } from "./contract.mjs";
import { runtimeNodeEnv } from "./process-tools.mjs";
import { installNodePortableWin } from "./windows-tools.mjs";

export async function upgradeNode(context) {
  const { processes, platform = process.platform } = context;
  console.log(`[upgrade-node] installing Node ${NODE_LTS_INSTALL} (LTS)…`);
  let result;
  if (platform === "darwin") {
    if (!processes.has("brew")) {
      console.error(`[upgrade-node] Homebrew not found — install Node ${NODE_LTS_INSTALL} manually from https://nodejs.org`);
      return 1;
    }
    result = processes.spawnSync("brew", ["install", `node@${NODE_LTS_INSTALL}`], { stdio: "inherit" });
    if (result.status === 0) result = processes.spawnSync("brew", ["link", "--overwrite", "--force", `node@${NODE_LTS_INSTALL}`], { stdio: "inherit" });
  } else if (platform === "win32") {
    result = await installNodePortableWin(context);
    if (result.status !== 0) {
      console.log("[upgrade-node] portable download failed — trying winget…");
      result = processes.spawnSync("winget", [
        "install", "OpenJS.NodeJS.LTS", ...WINGET_SOURCE,
        "--accept-package-agreements", "--accept-source-agreements", "--silent",
      ], { stdio: "inherit", shell: true });
      if (result.status === -1978335215) result.status = 0;
    }
  } else {
    result = processes.spawnSync("/bin/bash", ["-c",
      `curl -fsSL https://deb.nodesource.com/setup_${NODE_LTS_INSTALL}.x | sudo -E bash - && sudo apt-get install -y nodejs`,
    ], { stdio: "inherit" });
  }
  if (!result || result.status !== 0) {
    console.error(`[upgrade-node] install failed (exit ${result ? result.status : "spawn-error"}) — install Node ${NODE_LTS_INSTALL} manually from https://nodejs.org`);
    return 1;
  }
  console.log("[upgrade-node] rebuilding native modules…");
  const environment = runtimeNodeEnv(platform);
  const rebuild = processes.run("npm", ["rebuild", "better-sqlite3", "--no-audit", "--no-fund", "--loglevel=error"],
    environment ? { env: environment } : {});
  if (rebuild.status !== 0) {
    console.error("[upgrade-node] native rebuild failed — if the app fails to start, run `npm rebuild better-sqlite3` in the install directory.");
    return 1;
  }
  console.log("[upgrade-node] done.");
  return 0;
}
