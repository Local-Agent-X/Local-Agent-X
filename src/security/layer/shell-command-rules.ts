// Shell rules that judge the COMMAND BEING RUN — its real command word, its
// own arguments, what feeds its stdin — read from commandPositions, which also
// walks the bodies nested shells re-parse. A word inside a quoted argument
// (`git commit -m "fix eval"`) or a later, unrelated command (`a | head;
// powershell -File x.ps1`) is never mistaken for the command. The rules
// themselves live in shell-command-rule-table.ts.

import { commandPositions, MAX_SHELL_NESTING, type CommandPosition } from "./shell-command-positions.js";
import { isLoopbackHost } from "./ip-classification.js";
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
  /** Every loopback service is the operator's (a disposable sandbox): a raw
   *  TCP client may hold a session with one, not only probe it. */
  loopbackOpen?: boolean;
}

// Raw TCP clients whose target is a host argument. Checking that a local port
// answers (`nc -z 127.0.0.1 5432`: connect, send nothing) is how anyone sees
// whether a database or server came up, and no other tool does it; on a
// disposable sandbox a session with a local port (a VM's serial console on
// telnet) is the operator's own. Listening, running a program on the socket
// (-e/-c), a proxy hop and any non-loopback host keep the network rule.
const RAW_TCP_CLIENTS = new Set(["nc", "ncat", "nc.traditional", "netcat", "telnet"]);
const REROUTING_FLAG = /^-[a-zA-Z]*[lecxX]|^--(?:listen|exec|sh-exec|lua-exec|proxy)/;

/** "probe" for a connect-only check of a loopback port, "session" for any other
 *  talk with one, null when the client reaches anything else. */
function loopbackUse(p: CommandPosition): "probe" | "session" | null {
  if (!RAW_TCP_CLIENTS.has(p.bin)) return null;
  const args = p.words.slice(p.at + 1);
  if (args.some((a) => REROUTING_FLAG.test(a))) return null;
  const hosts = args.filter((a) => !a.startsWith("-") && !/^\d+(?:-\d+)?$/.test(a));
  if (hosts.length !== 1 || !isLoopbackHost(hosts[0].replace(/^\[|\]$/g, "").toLowerCase())) return null;
  return args.some((a) => /^-[a-zA-Z]*z/.test(a)) ? "probe" : "session";
}

const reachesOnlyLoopback = (p: CommandPosition, ctx: CommandRuleContext) => {
  const use = loopbackUse(p);
  return use === "probe" || (use === "session" && ctx.loopbackOpen === true);
};

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
  network: "For HTTP (including localhost and this app's own API) use `http_request`: it is SSRF-checked, " +
    "DNS-pinned and audited, and it can reach this app's own server and any registered dev server. " +
    "To download a file (a tarball, an installer, a dataset), call `http_request` with save_to set to the file's path. " +
    "To check that a local port is open, `nc -z 127.0.0.1 PORT` is allowed. " +
    "Other shell network clients stay refused here even for 127.0.0.1, because this app's own API can proxy on to other hosts.",
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
