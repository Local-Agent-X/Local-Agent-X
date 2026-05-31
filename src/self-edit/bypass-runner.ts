import { runSurgeon } from "./surgeon.js";
import { redactSecrets } from "../security/secret-scanner.js";

const MAX_OUTPUT_CHARS = 4000;

export type BypassResult = { content: string; isError?: boolean };

/**
 * Bypass flow: run the resolved surgeon CLI directly inside the supplied cwd.
 * Used when the autopilot route already supplies its own worktree (_cwd) or
 * when the caller explicitly requested _unsafe (emergency rescue). No sandbox
 * gates. The surgeon (claude / codex / grok) is picked from the active provider
 * by runSurgeon — see surgeon.ts.
 */
export async function runSelfEditBypass(
  subprocessCwd: string,
  fullPrompt: string,
  signal: AbortSignal | undefined,
): Promise<BypassResult> {
  const run = await runSurgeon(subprocessCwd, fullPrompt, signal);
  if (run.spawnError) {
    return { content: `self_edit spawn error: ${run.spawnError}`, isError: true };
  }
  if (run.exitCode !== 0 && !run.stdout) {
    return { content: `self_edit failed (exit ${run.exitCode}):\n${run.stderr.slice(0, 600)}`, isError: true };
  }
  // Redact any secret-shaped material the child echoed before it reaches
  // chat/logs — a child that read a credential shouldn't get to surface it.
  const output = redactSecrets(run.stdout.slice(0, MAX_OUTPUT_CHARS));
  return { content: output || `(no output, exit ${run.exitCode})` };
}
