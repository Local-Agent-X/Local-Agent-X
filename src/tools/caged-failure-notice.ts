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
