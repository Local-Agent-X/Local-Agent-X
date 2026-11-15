// Shared by the visual scenarios: where their starting files live, and a
// synchronous run of browser-probe.mjs (headless Chromium) on a built page.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
const PROBE = join(HERE, "..", "browser-probe.mjs");

/** The probe's JSON report, or { fatal } when it could not run. */
export function runProbe(mode, file) {
  try {
    const out = execFileSync(process.execPath, [PROBE, mode, file], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    const last = out.trim().split("\n").pop();
    return JSON.parse(last);
  } catch (e) {
    return { fatal: `probe failed: ${String(e.stderr || e.message).slice(0, 200)}` };
  }
}
