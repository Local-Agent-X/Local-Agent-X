// Shell rules that judge the COMMAND BEING RUN — its real command word, its
// own arguments, what feeds its stdin — read from commandPositions, which also
// walks the bodies nested shells re-parse. A word inside a quoted argument
// (`git commit -m "fix eval"`) or a later, unrelated command (`a | head;
// powershell -File x.ps1`) is never mistaken for the command. The rules
// themselves live in shell-command-rule-table.ts.

import { commandPositions, MAX_SHELL_NESTING, type CommandPosition } from "./shell-command-positions.js";
import { loopbackUse } from "./shell-loopback-clients.js";
import { COMMAND_RULES, type CommandRule } from "./shell-command-rule-table.js";

export { COMMAND_RULES, type CommandRule, type CommandRuleCategory } from "./shell-command-rule-table.js";

export type CommandRuleVerdict =
  | { kind: "rule"; rule: CommandRule; bin: string }
  | { kind: "too-deep" };

export interface CommandRuleContext {
  /** A kernel cage plus the egress proxy hold this spawn's network: the
   *  "network" rules stand down, because the cage decides what a client
   *  reaches and refusing the command here only costs the user working tools. */
  egressEnforced?: boolean;
  /** The command-shape rules stand down (a cage, or a disposable sandbox: the
   *  machine is the boundary they approximate), and with them the "background"
   *  and "inline-program" rules, as the bare `&` and python -c refusals do. */
  shapeRulesStandDown?: boolean;
  /** This server already runs as root, so sudo grants nothing it lacks: the
   *  "privilege" rules stand down. Defaults to the process's own uid. */
  root?: boolean;
  /** May a shell client reach this loopback destination (loopback-grant.ts
   *  shellLoopbackReachable)? `null` is a Unix socket. Absent: none may. */
  loopbackReachable?: (port: string | null) => boolean;
}

// A network client that names only this machine (shell-loopback-clients.ts)
// reaches no farther than http_request may, and gets the same grant. A
// connect-only check (`nc -z 127.0.0.1 5432`) sends nothing, so it may check
// any port: it is how anyone sees whether a database or server came up.
function reachesOnlyLoopback(p: CommandPosition, ctx: CommandRuleContext): boolean {
  const use = loopbackUse(p);
  if (!use) return false;
  if (use.probe) return true;
  const reachable = ctx.loopbackReachable;
  if (!reachable) return false;
  return use.ports.every((port) => reachable(port)) && (use.unixSockets.length === 0 || reachable(null));
}

const runningAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

/** The first rule the command breaks, or null. Nesting past the walk's depth is
 *  refused outright: a body the rules cannot see is not a body they allowed.
 *  Rule categories stand down as `ctx` says (CommandRuleContext). */
export function findCommandRuleHit(command: string, ctx: CommandRuleContext = {}): CommandRuleVerdict | null {
  const walk = commandPositions(command);
  const standsDown = (category: CommandRule["category"]) =>
    ((category === "background" || category === "inline-program") && ctx.shapeRulesStandDown === true)
    || (category === "privilege" && (ctx.root ?? runningAsRoot()));
  // The network rules are the backstop, judged after everything else across
  // the whole line: `wget … | sh` is refused for running the download, which
  // is the refusal that still stands once a cage lets wget itself run.
  for (const network of [false, true]) {
    if (network && ctx.egressEnforced) break;
    for (const p of walk.positions) {
      for (const rule of COMMAND_RULES) {
        if ((rule.category === "network") !== network || standsDown(rule.category)) continue;
        if (network && reachesOnlyLoopback(p, ctx)) continue;
        if (rule.matches(p)) return { kind: "rule", rule, bin: rule.offender?.(p) ?? p.words[p.at] };
      }
    }
  }
  return walk.tooDeep ? { kind: "too-deep" } : null;
}

// What the model can do instead, by what kind of thing was refused.
const WAY_OUT: Record<CommandRule["category"], string> = {
  network: "For HTTP use `http_request`: it is SSRF-checked, DNS-pinned and audited, and it can reach this app's own " +
    "server and any registered dev server. To download a file (a tarball, an installer, a dataset), call `http_request` " +
    "with save_to set to the file's path. A shell client (curl, ssh, nc, socat) may reach a local port that " +
    "`http_request` may, never this app's own port, and `nc -z 127.0.0.1 PORT` may check any local port; a proxy, " +
    "a tunnel or following redirects keeps it refused. Any other host stays refused: this app's own API can proxy on to it.",
  "shell-escape": "Run the command it would run directly, so it can be checked.",
  obfuscation: "Run the decoded command directly, so it can be checked.",
  privilege: "There is no shell path for this: tell the user what needs doing and why.",
  disk: "Writing a disk device erases it, so LAX leaves that to the user: give them the exact command and name the device it will erase.",
  "system-config": "There is no shell path for this: tell the user what needs doing and why.",
  persistence: "There is no shell path for this: tell the user what needs doing and why.",
  "inline-program": "Write the program to a file with the write tool and run the file (perl script.pl).",
  background: "To keep a server or watcher running, start it with the process_start tool: it stays up, " +
    "process_status reads its output, and process_stop ends it.",
  credential: "There is no shell path for this: tell the user what needs doing and why.",
  "local-server": "Start the project's own dev server (its dev script) with process_start instead.",
  opener: "To show a web page use the browser tool; for a file, tell the user where it is.",
};

export function commandRuleReason(hit: CommandRuleVerdict): string {
  if (hit.kind === "too-deep") return TOO_DEEP_REASON;
  return `Blocked: "${hit.bin}" ${hit.rule.why}. ${WAY_OUT[hit.rule.category]} ` +
    "Retrying the same command will be denied again.";
}

/** The way out alone, for the decision's `recovery` field. */
export function commandRuleRecovery(hit: CommandRuleVerdict): string {
  return hit.kind === "too-deep" ? "Run the inner command directly." : WAY_OUT[hit.rule.category];
}

export const TOO_DEEP_REASON =
  `Blocked: shells nested more than ${MAX_SHELL_NESTING - 1} deep (a shell -c body inside another). ` +
  "Run the inner command directly.";
