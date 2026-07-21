import { spawnSync } from "node:child_process";

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateProcessTree(child, graceMs = 1_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    await waitForExit(child, graceMs);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, graceMs);
    }
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
  await delay(graceMs);
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
  await waitForExit(child, graceMs);
}
