/**
 * Preflight probe — verify the harness↔worker environment contract BEFORE
 * chunk 1 burns a 30-minute run on a broken seam.
 *
 * Every failed food-truck-tracker round (Jul 2026) traced to a contract
 * break, not a bad worker: relative paths anchored to the wrong root, the
 * delegated write gate refusing the project dir, bash losing backslash
 * paths, the final report never reaching the reviewer. Each one cost a full
 * chunk timeout + a log autopsy to name. This probe runs a ~1-minute
 * synthetic task through the REAL worker path (same runChunkAgent, same
 * definition, same gates) and halts with the broken contract named.
 *
 * Complements the spec-probe gate (canonical-loop): that verifies the
 * MODEL's output at done-claim; this verifies the HARNESS's environment at
 * start. Opt out with LAX_BUILD_PREFLIGHT=0.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runChunkAgent, type ChunkAgentInvocation, type ChunkAgentResult } from "../agents/chunk-runner.js";
import { parseChunkReport } from "../chunk-review/report-parser.js";

export const PREFLIGHT_FILES = {
  sentinel: ".lax-preflight-sentinel.txt",
  echo: ".lax-preflight-echo.txt",
  bash: ".lax-preflight-bash.txt",
} as const;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export type PreflightResult =
  | { status: "pass"; durationMs: number }
  | { status: "skipped" }
  | { status: "fail"; contract: string; detail: string };

export interface PreflightOptions {
  projectDir: string;
  parentSessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type ChunkRunner = (opts: ChunkAgentInvocation) => Promise<ChunkAgentResult>;

function preflightTask(projectRootFwd: string, token: string): string {
  return (
    `## Preflight probe — harness environment check (NOT a real chunk)\n\n` +
    `The build harness is verifying its own contract with you before the first ` +
    `real chunk. Do exactly these four steps in order and nothing else — do not ` +
    `explore the project, read the plan, or touch any other file.\n\n` +
    `1. Read the file \`${PREFLIGHT_FILES.sentinel}\` (relative path — it sits in ` +
    `your project root). It contains a single short token.\n` +
    `2. Using your file WRITE tool with a relative path, create ` +
    `\`${PREFLIGHT_FILES.echo}\` containing exactly that token and nothing else.\n` +
    `3. Using bash, run exactly:\n` +
    `   cd "${projectRootFwd}" && cp ${PREFLIGHT_FILES.echo} ${PREFLIGHT_FILES.bash}\n` +
    `4. Reply with the standard report block, NOTE carrying the token:\n\n` +
    `STATUS: done\n` +
    `DONE_WHEN: met\n` +
    `CHANGED: ${PREFLIGHT_FILES.echo}, ${PREFLIGHT_FILES.bash}\n` +
    `TESTS: n/a\n` +
    `NEW_FAILURES: none\n` +
    `PRE_EXISTING_FAILURES: none\n` +
    `SPEC_GAPS: none\n` +
    `LAUNCH_READINESS: none\n` +
    `NOTE: preflight token <the token you read>`
  );
}

/** Run the environment probe through the real worker path. Never throws —
 *  a failure comes back named so the loop can halt with a diagnosis instead
 *  of letting chunk 1 flail into the same wall for 30 minutes. */
export async function runPreflightProbe(
  opts: PreflightOptions,
  runner: ChunkRunner = runChunkAgent,
): Promise<PreflightResult> {
  const flag = (process.env.LAX_BUILD_PREFLIGHT || "").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return { status: "skipped" };

  const token = randomBytes(6).toString("hex");
  const paths = {
    sentinel: join(opts.projectDir, PREFLIGHT_FILES.sentinel),
    echo: join(opts.projectDir, PREFLIGHT_FILES.echo),
    bash: join(opts.projectDir, PREFLIGHT_FILES.bash),
  };

  try {
    writeFileSync(paths.sentinel, token + "\n");
  } catch (e) {
    return { status: "fail", contract: "harness-fs", detail: `could not write sentinel into ${opts.projectDir}: ${(e as Error).message}` };
  }

  const projectRootFwd = opts.projectDir.replace(/\\/g, "/");
  try {
    const result = await runner({
      role: "chunk-runner-trunk",
      task: preflightTask(projectRootFwd, token),
      projectDir: opts.projectDir,
      parentSessionId: opts.parentSessionId,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return verdict(result, token, paths);
  } catch (e) {
    return { status: "fail", contract: "worker-invocation", detail: `canonical agent path threw: ${(e as Error).message}` };
  } finally {
    for (const p of Object.values(paths)) {
      try { rmSync(p, { force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

/** The verification ladder. First broken rung names the contract — ordered
 *  so each check only fires when everything beneath it held. */
function verdict(result: ChunkAgentResult, token: string, paths: Record<"sentinel" | "echo" | "bash", string>): PreflightResult {
  if (result.exitCode === 124) {
    return { status: "fail", contract: "worker-timeout", detail: `worker produced no result within the probe window — provider stall or event plumbing (handler:agent-result) not firing. ${result.error ?? ""}`.trim() };
  }
  if (result.exitCode !== 0) {
    return { status: "fail", contract: "worker-invocation", detail: `worker run failed (exit=${result.exitCode}): ${result.error || result.stdout.slice(-400) || "(no output)"}` };
  }

  const report = parseChunkReport(result.stdout);
  if (!report.parsed) {
    return { status: "fail", contract: "report-shape", detail: `worker's final message had no parseable STATUS/DONE_WHEN block — result extraction or report discipline broken. Output tail: ${JSON.stringify(result.stdout.slice(-400))}` };
  }

  if (!existsSync(paths.echo)) {
    return { status: "fail", contract: "file-write-anchoring", detail: `relative write of ${PREFLIGHT_FILES.echo} did not land in the project root — work-root anchoring or the delegated write gate is broken.` };
  }
  const echoed = readFileSync(paths.echo, "utf-8").trim();
  if (echoed !== token) {
    return { status: "fail", contract: "file-read-anchoring", detail: `worker wrote ${JSON.stringify(echoed.slice(0, 80))} instead of the sentinel token — it could not read ${PREFLIGHT_FILES.sentinel} via a relative path (wrong anchor root).` };
  }

  if (!existsSync(paths.bash)) {
    return { status: "fail", contract: "bash-cwd", detail: `bash \`cd "<project root>" && cp\` produced no file — shell policy, cwd anchoring, or path quoting is broken.` };
  }
  const bashed = readFileSync(paths.bash, "utf-8").trim();
  if (bashed !== token) {
    return { status: "fail", contract: "bash-cwd", detail: `bash copy carried ${JSON.stringify(bashed.slice(0, 80))} instead of the token — the shell resolved a different working directory than the project root.` };
  }

  return { status: "pass", durationMs: result.durationMs };
}
