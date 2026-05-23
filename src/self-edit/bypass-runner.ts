import { spawn } from "node:child_process";
import { npmAugmentedEnv } from "../anthropic-client/cli-path.js";
import { killProcessTree } from "../process-tree-kill.js";

const MAX_OUTPUT_CHARS = 4000;
const TIMEOUT_MS = 10 * 60_000; // 10 min — source-code repair can be slow

export type BypassResult = { content: string; isError?: boolean };

/**
 * Bypass flow: run `claude -p` directly inside the supplied cwd. Used when
 * the autopilot route already supplies its own worktree (_cwd) or when the
 * caller explicitly requested _unsafe (emergency rescue). No sandbox gates.
 */
export function runSelfEditBypass(
  subprocessCwd: string,
  fullPrompt: string,
  signal: AbortSignal | undefined,
): Promise<BypassResult> {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", [
      "-p",
      "--model", "claude-opus-4-7",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--output-format", "text",
    ], {
      cwd: subprocessCwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: npmAugmentedEnv(),
    });

    // Windows shell:true → cmd.exe wrapper → proc.kill only signals
    // the wrapper. killProcessTree handles both: SIGTERM the wrapper
    // AND taskkill /F /T the descendant tree so claude.exe dies too.
    const killTree = () => killProcessTree(proc);
    const abortListener = killTree;
    signal?.addEventListener("abort", abortListener);

    const timer = setTimeout(killTree, TIMEOUT_MS);

    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); if (stdout.length > MAX_OUTPUT_CHARS * 3) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 3); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    proc.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      resolveP({ content: `self_edit spawn error: ${e.message}`, isError: true });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      if (code !== 0 && !stdout.trim()) {
        resolveP({ content: `self_edit failed (exit ${code}):\n${stderr.slice(0, 600)}`, isError: true });
        return;
      }
      const output = stdout.trim().slice(0, MAX_OUTPUT_CHARS);
      resolveP({ content: output || `(no output, exit ${code})` });
    });

    proc.stdin?.write(fullPrompt);
    proc.stdin?.end();
  });
}
