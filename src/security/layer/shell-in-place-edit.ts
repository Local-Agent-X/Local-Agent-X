// An in-place file editor run from the shell (`sed -i`, awk's `inplace`): which
// command positions are one, and which files it would rewrite. The script-write
// rule (shell-detectors.ts) refuses the form; the path guard
// (shell-path-guard.ts) judges the files, so a refusal names the edit's real
// target and never a path the command only reads.

import { commandPositions, type CommandPosition } from "./shell-command-positions.js";

const AWK_FAMILY = new Set(["awk", "gawk", "mawk", "nawk"]);

/** `sed` with `-i` in any short cluster or `--in-place[=suffix]`; awk with
 *  its `inplace` extension. */
export function editsInPlace(p: CommandPosition): boolean {
  const args = p.words.slice(p.at + 1);
  if (p.bin === "sed") return args.some((a) => /^-[a-zA-Z]*i/.test(a) || /^--in-place(?:=|$)/.test(a));
  return AWK_FAMILY.has(p.bin) && args.some((a) => /\binplace\b/i.test(a));
}

/**
 * The files an in-place `sed`/awk would rewrite: its operands after the
 * script. The first operand is the script unless `-e`/`-f` gave one; awk's
 * `-i`/`-f`/`-v` each take a value.
 */
export function inPlaceEditTargets(command: string): string[] {
  const out: string[] = [];
  for (const p of commandPositions(command).positions) {
    if (!editsInPlace(p)) continue;
    const args = p.words.slice(p.at + 1);
    const takesValue = AWK_FAMILY.has(p.bin) ? /^-[ifv]$/ : /^(-[a-zA-Z]*[ef]|--expression|--file)$/;
    let scriptSeen = false;
    for (let i = 0; i < args.length; i++) {
      if (takesValue.test(args[i])) { scriptSeen ||= !/^-[iv]$/.test(args[i]); i++; continue; }
      if (args[i].startsWith("-")) continue;
      if (scriptSeen) out.push(args[i]);
      scriptSeen = true;
    }
  }
  return out;
}
