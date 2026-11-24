/**
 * The iOS Simulator through `xcrun simctl` (macOS only: Apple ships the
 * Simulator with Xcode and nowhere else). One thin wrapper per subcommand.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIosText, runIosTool } from "./run.js";

export interface Simulator {
  udid: string;
  name: string;
  state: string; // "Booted" | "Shutdown" | ...
  /** e.g. "iOS 18.1", from the runtime identifier. */
  os: string;
}

/** `simctl list devices -j`: every available simulator, booted ones first. */
export function parseSimulatorList(json: string): Simulator[] {
  const data = JSON.parse(json) as { devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> };
  const out: Simulator[] = [];
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    const m = /SimRuntime\.(\w+)-([\d-]+)$/.exec(runtime);
    const os = m ? `${m[1]} ${m[2].replace(/-/g, ".")}` : runtime;
    for (const d of devices) if (d.isAvailable !== false) out.push({ udid: d.udid, name: d.name, state: d.state, os });
  }
  return out.sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted"));
}

const xcrun = (args: string[], timeoutMs?: number) => runIosText("xcrun", ["simctl", ...args], timeoutMs);

export async function listSimulators(): Promise<Simulator[]> {
  return parseSimulatorList(await xcrun(["list", "devices", "-j"]));
}

/** Boot by udid or name and wait until it is ready. Already booted is fine. */
export async function bootSimulator(idOrName: string): Promise<Simulator> {
  const sims = await listSimulators();
  const sim = sims.find((s) => s.udid === idOrName) ?? sims.find((s) => s.name === idOrName);
  if (!sim) throw new Error(`No simulator named or with udid "${idOrName}". Available: ${sims.map((s) => s.name).join(", ")}`);
  if (sim.state !== "Booted") await runIosTool("xcrun", ["simctl", "boot", sim.udid], 60_000);
  await xcrun(["bootstatus", sim.udid, "-b"], 180_000);
  return { ...sim, state: "Booted" };
}

export async function installSimulatorApp(udid: string, appPath: string): Promise<void> {
  await xcrun(["install", udid, appPath], 120_000);
}

export async function launchSimulatorApp(udid: string, bundleId: string): Promise<void> {
  await xcrun(["launch", udid, bundleId]);
}

export async function openSimulatorUrl(udid: string, url: string): Promise<void> {
  await xcrun(["openurl", udid, url]);
}

/** Is the app installed? `get_app_container` fails when it is not. */
export async function simulatorHasApp(udid: string, bundleId: string): Promise<boolean> {
  const r = await runIosTool("xcrun", ["simctl", "get_app_container", udid, bundleId]);
  return r.code === 0;
}

export async function simulatorScreenshot(udid: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "lax-ios-shot-"));
  try {
    const file = join(dir, "screen.png");
    await xcrun(["io", udid, "screenshot", "--type=png", file], 30_000);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The simulator's unified log for the last `minutes`, one syslog-style line
 *  per entry (`YYYY-MM-DD HH:MM:SS.ffffff±zzzz host Process[pid]: message`). */
export async function simulatorLog(udid: string, minutes = 30): Promise<string> {
  return xcrun(["spawn", udid, "log", "show", "--last", `${minutes}m`, "--style", "syslog"], 120_000);
}
