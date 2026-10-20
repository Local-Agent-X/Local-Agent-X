/**
 * The "disposable sandbox" switch: security.json `"disposableSandbox": true`,
 * off unless the operator sets it.
 *
 * It says this machine is throwaway, or one LAX is meant to administer: a
 * container, a VM, a server. In unrestricted file-access mode it lifts the two
 * write floors file-access.ts otherwise keeps there, system directories
 * (catastrophic-paths.ts) and "outside the home directory", so system work
 * (/etc/nginx, /var/www, a hosts file) can be done with the file tools.
 * Everything that protects LAX itself (its install, control files, secrets)
 * still holds, and so does the shell's catastrophic-delete floor.
 *
 * It also stands down shell-policy.ts's command-shape heuristics (separators,
 * backgrounding, script writes, inline-eval forms), as a confining sandbox
 * does: they approximate a process boundary the machine itself now is. The
 * network rules, the nested-command check, decode-and-run, rm and the denylist
 * stay on.
 *
 * And it opens every loopback port to the agent's HTTP tools (network-policy.ts):
 * the services listening on the machine are the operator's, including daemons
 * like nginx that process_start never tracks. The LAN and metadata stay refused.
 *
 * Read from disk on every call, like the other security.json switches in
 * security-config.ts, so a decision never runs on a stale value. A leaf module
 * because file-access.ts needs it and security-config.ts's imports would make
 * a cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

export function isDisposableSandbox(): boolean {
  try {
    const path = join(getLaxDir(), "security.json");
    if (!existsSync(path)) return false;
    return JSON.parse(readFileSync(path, "utf-8"))?.disposableSandbox === true;
  } catch {
    // Unreadable or malformed security.json: the switch is not shown to be on.
    return false;
  }
}

/** Appended to a floor refusal so the person (or the model telling them) knows the way out. */
export const DISPOSABLE_SANDBOX_HINT =
  'On a throwaway machine (a container, a VM, a server LAX administers), set "disposableSandbox": true in security.json to allow it.';
