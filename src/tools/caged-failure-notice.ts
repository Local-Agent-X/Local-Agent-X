/**
 * What the cage did to a command that a build ran, for the text the builder
 * reads. A project's own `npm test` or `npm run build` runs in the shell cage
 * (caged-spawn.ts), and a test that opens its database or a local model over
 * loopback is refused there with the same ECONNREFUSED a dead service gives.
 * The shell tool has always said so; a build's failure said only "exited 1",
 * and the builder went off to fix a database that was fine.
 */
import { cageDenialNotices } from "../sandbox/index.js";
import type { CagedRunOutcome } from "./caged-spawn.js";
import { isPortBound } from "./process-session.js";

/**
 * The cage notices for a caged run that exited non-zero, each on its own line
 * after a leading newline, ready to append to a failure message; "" when the
 * run passed, never finished, or its output shows nothing the cage did.
 * `listening` answers whether a port is bound on the host.
 */
export function cagedFailureNotice(
  outcome: CagedRunOutcome,
  listening: (port: number) => boolean | null = isPortBound,
  platform: NodeJS.Platform = process.platform,
): string {
  if (outcome.kind !== "exit" || outcome.code === 0) return "";
  const notices = cageDenialNotices(outcome.sandboxMode, `${outcome.stdout}\n${outcome.stderr}`, listening, platform);
  return notices.length ? `\n${notices.join("\n")}` : "";
}

/**
 * What a machine prints when it, not the program, stopped a command: the
 * operating system refusing to load a file, a policy blocking a program, no
 * device to run on. Read from the command's own output, never from a model's
 * account of it. A build that hit one of these is not a failed build: Windows
 * Application Control blocked a native parser inside label-check-sol's
 * `npm run check`, the engine read "exited 1", and the worker was sent back
 * round after round to fix code that was fine (2026-11-25).
 */
const MACHINE_REFUSALS: readonly { what: string; pattern: RegExp }[] = [
  { what: "Windows Application Control blocked a file the command loads", pattern: /Application Control policy has blocked this file|blocked by (?:your organization's )?(?:Device Guard|Code Integrity)/i },
  { what: "a group policy on this machine blocks the program", pattern: /This program is blocked by group policy|This app has been blocked by your system administrator/i },
  { what: "this machine's antivirus blocked a file", pattern: /Operation did not complete successfully because the file contains a virus/i },
  { what: "no phone or emulator is connected to this machine", pattern: /no devices\/emulators found|No connected devices|No Android connected device found/i },
];

/** The machine's refusal in what a program printed, or null: for output that
 *  is not a caged run's (an app the judge started that died before it was ready). */
export function machineRefusalIn(output: string): string | null {
  return MACHINE_REFUSALS.find((r) => r.pattern.test(output))?.what ?? null;
}

/**
 * Why this machine stopped a command that ran and exited non-zero, or null
 * when its output shows nothing the machine did (then it simply failed). The
 * shell cage's own refusals count: a test refused its database over loopback
 * is this machine's doing too.
 */
export function machineRefusal(
  outcome: CagedRunOutcome,
  listening: (port: number) => boolean | null = isPortBound,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (outcome.kind !== "exit" || outcome.code === 0) return null;
  const output = `${outcome.stdout}\n${outcome.stderr}`;
  const hit = machineRefusalIn(output);
  if (hit) return hit;
  const cage = cageDenialNotices(outcome.sandboxMode, output, listening, platform);
  return cage.length ? `the shell cage refused something it tried: ${cage[0].replace(/\s+/g, " ").trim()}` : null;
}
