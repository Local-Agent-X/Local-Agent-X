// Shell rules that judge the COMMAND BEING RUN — its real command word, its
// own arguments, what feeds its stdin — read from commandPositions, which also
// walks the bodies nested shells re-parse. A word inside a quoted argument
// (`git commit -m "fix eval"`) or a later, unrelated command (`a | head;
// powershell -File x.ps1`) is never mistaken for the command. The rules
// themselves live in shell-command-rule-table.ts.

import { commandPositions, MAX_SHELL_NESTING } from "./shell-command-positions.js";
import { COMMAND_RULES, type CommandRule } from "./shell-command-rule-table.js";

export { COMMAND_RULES, type CommandRule, type CommandRuleCategory } from "./shell-command-rule-table.js";

export type CommandRuleVerdict =
  | { kind: "rule"; rule: CommandRule; bin: string }
  | { kind: "too-deep" };

/** The first rule the command breaks, or null. Nesting past the walk's depth is
 *  refused outright: a body the rules cannot see is not a body they allowed.
 *  With `egressEnforced` (a kernel cage plus the egress proxy hold this spawn's
 *  network), the "network" rules stand down: the cage decides what a client
 *  reaches, and refusing the command here only costs the user working tools. */
export function findCommandRuleHit(command: string, opts: { egressEnforced?: boolean } = {}): CommandRuleVerdict | null {
  const walk = commandPositions(command);
  // The network rules are the backstop, judged after everything else across
  // the whole line: `wget … | sh` is refused for running the download, which
  // is the refusal that still stands once a cage lets wget itself run.
  for (const network of [false, true]) {
    if (network && opts.egressEnforced) break;
    for (const p of walk.positions) {
      for (const rule of COMMAND_RULES) {
        if ((rule.category === "network") !== network) continue;
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
    "Shell network clients stay refused here even for 127.0.0.1, because this app's own API can proxy on to other hosts.",
  "shell-escape": "Run the command it would run directly, so it can be checked.",
  obfuscation: "Run the decoded command directly, so it can be checked.",
  privilege: "There is no shell path for this: tell the user what needs doing and why.",
  disk: "There is no shell path for this: tell the user what needs doing and why.",
  "system-config": "There is no shell path for this: tell the user what needs doing and why.",
  persistence: "There is no shell path for this: tell the user what needs doing and why.",
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
