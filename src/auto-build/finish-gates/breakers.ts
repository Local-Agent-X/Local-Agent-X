/**
 * The break-it agents the finish gates send at the whole app: the /greenfield
 * skill's finish gates (references/gates.md, sections 2-4), which LAX's engine
 * never ran. A build "complete" at its last chunk had no hostile, unlucky or
 * auditing eye on the whole app, and no security or quality pass (label-check,
 * 2026-11-23); the same app built under that skill had all four, and they
 * found a cross-tab privacy leak, a missing timeout and 61 quotes cut without
 * a mark.
 *
 * Each persona is one `finish-breaker` agent (agents/chunk-runner.ts: read,
 * search, shell, no edit; its writes fenced to the probe folder) over the
 * finished app, told what to hunt for. It answers with a FINDINGS block, one
 * line per finding with its severity. Critical, high and medium findings are
 * fixed (finish-gates/run.ts); low ones are listed.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runChunkAgent, SKEPTIC_PROBE_DIR } from "../agents/chunk-runner.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface BreakerFinding {
  severity: Severity;
  text: string;
}

export interface BreakerResult {
  persona: string;
  /** not-run: the agent never answered (crash, timeout, cancel) or gave no
   *  FINDINGS block; the run says that persona did not check the app. */
  status: "ran" | "not-run";
  findings: BreakerFinding[];
  /** not-run: why. */
  note?: string;
}

export interface Persona {
  name: string;
  hunt: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    name: "hostile",
    hunt: "Attack it as someone who wants it to misbehave: crafted and oversized input, injection into anything " +
      "parsed or rendered, spoofed or hidden text, a second tab or window, data that leaves the device when " +
      "the spec says it must not, secrets in the code or logs. Include a security review: permissions, what " +
      "each network call sends and to whom, what is stored and where.",
  },
  {
    name: "unlucky",
    hunt: "Use it as someone things go wrong for: the network drops mid-request, storage is full or unreadable, " +
      "a permission is denied then granted, a slow service never answers, the app is closed or reloaded " +
      "mid-flow, empty and huge lists. Every failure must tell the person what happened and leave nothing " +
      "half-done or lost.",
  },
  {
    name: "auditor",
    hunt: "Hold the app to its own word: every claim in spec/, README and the UI against what the code does, " +
      "data copied from a source against that source, a rule stated in the constitution that nothing enforces, " +
      "a test that cannot fail. Cite the line of spec it breaks.",
  },
  {
    name: "quality",
    hunt: "Review the code as the next maintainer: duplicated logic that will drift, dead code, a module doing " +
      "two jobs, a file or function past the project's size rules, error handling that swallows failures, " +
      "unhandled promise rejections, names that mislead.",
  },
];

const MAX_FINDINGS = 12;

export function buildBreakerTask(persona: Persona): string {
  return (
    `The app in this project says it is finished. Its spec is in \`spec/\`. Your angle: **${persona.name}**.\n\n` +
    `${persona.hunt}\n\n` +
    `Read the code, run the app's tests and your own probes, and show each finding: the input or case, ` +
    `file:line, and how you showed it. A finding you ran beats one you traced. Report only what you found ` +
    `from your angle; do not fix anything.\n\n` +
    `End with exactly this block, column-0 lines, nothing after:\n\n` +
    `FINDINGS:\n- [critical|high|medium|low] <what breaks, the input or case, file:line, how you showed it>\n` +
    `(one "- " line per finding, at most ${MAX_FINDINGS}; or "FINDINGS: none")`
  );
}

/** Read the FINDINGS block from the agent's last message. The last FINDINGS
 *  line wins (an agent may quote the format first). No block → null: the
 *  persona did not report, which is not a clean app. */
export function parseBreakerFindings(raw: string): BreakerFinding[] | null {
  const lines = raw.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*\**FINDINGS\**\s*:/i.test(lines[i])) at = i;
  if (at < 0) return null;
  const inline = lines[at].replace(/^\s*\**FINDINGS\**\s*:\s*\**\s*/i, "").trim();
  if (/^\(?none\)?\.?$/i.test(inline)) return [];
  const findings: BreakerFinding[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s*[-*•]\s*\[?(critical|high|medium|low)\]?\s*[:—-]?\s*(.+)$/i);
    if (m) findings.push({ severity: m[1].toLowerCase() as Severity, text: m[2].trim() });
  }
  return findings.slice(0, MAX_FINDINGS);
}

export interface RunBreakersInput {
  projectDir: string;
  signal?: AbortSignal;
  parentSessionId?: string;
  parentOpId?: string;
  /** Test seam: the agent call. */
  run?: typeof runChunkAgent;
}

/** Every persona at once over the finished app. The probe folder is shared and
 *  removed when the last one finishes. */
export async function runBreakers(input: RunBreakersInput): Promise<BreakerResult[]> {
  const run = input.run ?? runChunkAgent;
  const probes = join(input.projectDir, SKEPTIC_PROBE_DIR);
  const ownFolder = !existsSync(probes);
  try {
    return await Promise.all(PERSONAS.map(async (persona): Promise<BreakerResult> => {
      const result = await run({
        role: "finish-breaker",
        task: buildBreakerTask(persona),
        title: `Break it (${persona.name}): the finished app`,
        projectDir: input.projectDir,
        signal: input.signal,
        parentSessionId: input.parentSessionId,
        parentOpId: input.parentOpId,
      });
      if (result.exitCode !== 0) {
        return { persona: persona.name, status: "not-run", findings: [], note: `did not finish (exit ${result.exitCode}${result.error ? `: ${result.error}` : ""})` };
      }
      const findings = parseBreakerFindings(result.stdout);
      if (!findings) return { persona: persona.name, status: "not-run", findings: [], note: "gave no FINDINGS block" };
      return { persona: persona.name, status: "ran", findings };
    }));
  } finally {
    if (ownFolder) rmSync(probes, { recursive: true, force: true });
  }
}
