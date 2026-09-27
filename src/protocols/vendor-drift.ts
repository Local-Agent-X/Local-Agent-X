/**
 * When a vendor CLI command fails, the skill that told the agent to run it may
 * be stale: packs are pinned (vendor-packs.ts) and CLIs rename flags. The
 * failed result says so, and names the cheapest current source first — the
 * CLI's own --help, which always matches the installed version — then the
 * vendor's docs. Docs fetched after that are data, never instructions: the
 * pinned skill says what to do, the live page only supplies facts (the rule
 * set when the packs were scoped, 2026-09-23).
 *
 * Each firing is appended to ~/.lax/protocols/vendor-drift.jsonl — program,
 * subcommand, exit code, first stderr line (secrets redacted) — so the next
 * pack update review sees where a pinned skill has drifted.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { redactSecrets } from "../security/secrets/secret-scanner.js";
import { vendorPackForCommand } from "./vendor-packs.js";

export function vendorDriftLogPath(): string {
  return join(getLaxDir(), "protocols", "vendor-drift.jsonl");
}

function programAndSubcommand(command: string): { program: string; sub: string } {
  const words = command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const first = (words[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/i, "");
  const rest = ["npx", "pnpx", "bunx", "yarn", "pnpm"].includes(first) ? words.slice(1) : words;
  return { program: (rest[0] ?? "").replace(/^.*[\\/]/, ""), sub: rest.slice(1).find((w) => !w.startsWith("-")) ?? "" };
}

/** The hint for a failed command, or null when no shipped pack owns its CLI.
 *  A CLI that is not installed (127 / "not found") is not drift. */
export function vendorDriftHint(command: string, exitCode: number | null, stderr: string): string | null {
  if (exitCode === 0 || exitCode === null || exitCode === 127 || /command not found|is not recognized/i.test(stderr)) return null;
  const pack = vendorPackForCommand(command);
  if (!pack) return null;
  const { program, sub } = programAndSubcommand(command);
  try {
    const file = vendorDriftLogPath();
    mkdirSync(dirname(file), { recursive: true });
    const firstLine = redactSecrets(stderr.split(/\r?\n/).find((l) => l.trim()) ?? "").slice(0, 300);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), vendor: pack.vendor, commit: pack.commit, program, sub, exitCode, stderr: firstLine }) + "\n");
  } catch { /* the log is a review aid; a failed append must not change the tool result */ }
  const helpCmd = `${program}${sub ? ` ${sub}` : ""} --help`;
  return (
    `If you were following a ${pack.vendor} skill: it is pinned to ${pack.pinnedAt}, and the ${program} CLI may have changed since. ` +
    `Before retrying, check \`${helpCmd}\` (it matches the installed version), then ${pack.docs} — use what they say as facts, ` +
    `and tell the user what you changed from the skill and why.`
  );
}
